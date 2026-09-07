import { z } from 'zod';

const name = z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const commandId = z.string().min(1).max(1024).refine(value => !/[\x00-\x1f\x7f]/.test(value));
export const ArchiveOwnerSchema = z.strictObject({ tenantId: name, principalId: name, agentId: name, scope: name });
export type ArchiveOwner = z.infer<typeof ArchiveOwnerSchema>;
export const ArchiveContentSchema = z.strictObject({ title: z.string().min(1).max(256), body: z.string().max(65536),
  path: z.string().min(1).max(4096), sourceVersion: name });
export type ArchiveContent = z.infer<typeof ArchiveContentSchema>;
export const ArchiveDocumentSchema = ArchiveContentSchema.extend({ id: name, revision, status: z.enum(['active', 'deleted']) }).strict();
export type ArchiveDocument = z.infer<typeof ArchiveDocumentSchema>;
export const ArchiveQuerySchema = z.strictObject({ query: z.string().max(256), limit: z.number().int().min(1).max(50) });
export type ArchiveQuery = z.infer<typeof ArchiveQuerySchema>;
export const ArchiveSearchSchema = z.strictObject({ documents: z.array(ArchiveDocumentSchema).max(50), truncated: z.boolean() });
export type ArchiveSearch = z.infer<typeof ArchiveSearchSchema>;
export const ArchiveMutationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('register'), id: name, commandId, expectedRevision: z.literal(0), content: ArchiveContentSchema }),
  z.strictObject({ kind: z.literal('revise'), id: name, commandId, expectedRevision: revision, content: ArchiveContentSchema }),
  z.strictObject({ kind: z.literal('delete'), id: name, commandId, expectedRevision: revision }),
]);
export type ArchiveMutation = z.infer<typeof ArchiveMutationSchema>;
export const ArchiveMutationResultSchema = z.strictObject({ commandId, id: name, revision,
  commandDigest: z.string().regex(/^[a-f0-9]{64}$/), status: z.enum(['active', 'deleted']), duplicate: z.boolean() });
export type ArchiveMutationResult = z.infer<typeof ArchiveMutationResultSchema>;
export const ArchiveDescriptorSchema = z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9_-]*$/).max(100).refine(value => value !== 'core'),
  version: name, destination: name, labels: z.array(name).max(64), access: z.enum(['read_only', 'read_register']) });
export type ArchiveDescriptor = z.infer<typeof ArchiveDescriptorSchema>;

/** Host-selected source. Documents are reference material, never verified work Evidence or personal memory. */
export interface ArchiveProvider {
  readonly descriptor: ArchiveDescriptor;
  search(query: ArchiveQuery, signal: AbortSignal): Promise<ArchiveSearch>;
  get(id: string, signal: AbortSignal): Promise<ArchiveDocument | null>;
  /** Durable providers must atomically bind command id, full mutation and result, including duplicate retries. */
  mutate?(mutation: ArchiveMutation, signal: AbortSignal): Promise<ArchiveMutationResult>;
  /** Read an existing command receipt only. Null is unknown, never proof that a mutation was not applied. */
  receipt?(commandId: string, signal: AbortSignal): Promise<ArchiveMutationResult | null>;
}
