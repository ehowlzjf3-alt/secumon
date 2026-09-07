import { z } from 'zod';
import { JsonSchema } from './contracts.js';

const id = z.string().min(1).max(256), metadata = z.record(z.string(), JsonSchema);
const extras = { metadata: metadata.optional(), mediaType: z.string().max(256).optional() };
/** Explicit text/data subset of A2A 1.0. File URLs/bytes and extension-driven behavior are not executed. */
export const A2aPartSchema = z.union([
  z.strictObject({ text: z.string().max(65536), ...extras }),
  z.strictObject({ data: JsonSchema, ...extras }),
]);
export const A2aMessageSchema = z.strictObject({ messageId: id, role: z.enum(['ROLE_USER', 'ROLE_AGENT']),
  contextId: id.optional(), taskId: id.optional(), parts: z.array(A2aPartSchema).min(1).max(32), metadata: metadata.optional() });
export type A2aMessage = z.infer<typeof A2aMessageSchema>;
export const A2aTaskSchema = z.strictObject({ id, contextId: id.optional(),
  status: z.strictObject({ state: z.enum(['TASK_STATE_UNSPECIFIED', 'TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED',
    'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_REJECTED', 'TASK_STATE_AUTH_REQUIRED']),
    message: A2aMessageSchema.optional(), timestamp: z.iso.datetime({ offset: true }).optional() }),
  artifacts: z.array(z.strictObject({ artifactId: id, name: z.string().max(256).optional(), description: z.string().max(4096).optional(),
    parts: z.array(A2aPartSchema).min(1).max(32), metadata: metadata.optional() })).max(64).optional(),
  history: z.array(A2aMessageSchema).max(20).optional(), metadata: metadata.optional() });
export type A2aTask = z.infer<typeof A2aTaskSchema>;
export const A2aReplySchema = z.union([z.strictObject({ task: A2aTaskSchema }), z.strictObject({ message: A2aMessageSchema })]);
export type A2aReply = z.infer<typeof A2aReplySchema>;
export interface A2aCall { requestId: string; signal: AbortSignal; authorize?: () => Promise<void> }
export interface A2aPeer {
  readonly id: string; readonly protocolVersion: '1.0'; readonly destination: string; readonly labels: readonly string[];
  send(message: A2aMessage, call: A2aCall): Promise<A2aReply>;
  get(taskId: string, call: A2aCall): Promise<A2aTask>;
  cancel(taskId: string, call: A2aCall): Promise<A2aTask>;
  close(): Promise<void>;
}
