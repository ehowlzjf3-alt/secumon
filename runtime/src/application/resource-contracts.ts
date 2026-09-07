import { z } from 'zod';
import { JsonSchema } from './contracts.js';
import type { ToolDefinition } from './ports.js';
import { ReadLimitsSchema } from './read-collection-contracts.js';
import { COMPUTER_INPUT_ASSURANCES } from '../domain/computer-use.js';

const id = z.string().min(1).max(256);
export const ToolDefinitionSchema: z.ZodType<ToolDefinition> = z.strictObject({
  provider: z.string().regex(/^[a-z][a-z0-9_-]*$/).max(100), id, version: id,
  description: z.string().min(1).max(10000), effect: z.enum(['read', 'write']), inputSchema: JsonSchema, outputSchema: JsonSchema,
  destination: id, labels: z.array(id).max(100),
  resultValidation: z.literal('artifact-proof-v1').optional(),
  computerContinuation: z.enum(['continue', 'verify']).optional(),
  computerInputAssurance: z.enum(COMPUTER_INPUT_ASSURANCES).optional(),
  collection: z.strictObject({ kind: z.enum(['batch', 'paged']), limits: ReadLimitsSchema,
    pageValidation: z.literal('artifact-proof-v1').optional(), deferralValidation: z.literal('artifact-proof-v1').optional(),
    responseRecovery: z.literal('stored-response-v1').optional(), coverage: z.literal('manifest-v1').optional() }).optional(),
  reuse: z.discriminatedUnion('mode', [z.strictObject({ mode: z.literal('immutable'), sourceVersion: id }),
    z.strictObject({ mode: z.literal('ttl'), maxAgeMs: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) })]).optional(),
}).refine(d => d.id.startsWith(`${d.provider}.`) && d.id.length > d.provider.length + 1, 'tool_id_requires_provider_namespace')
  .refine(d => !d.reuse || d.effect === 'read', 'reuse_requires_read')
  .refine(d => !d.collection || (d.effect === 'read' && !d.reuse), 'collection_requires_read_without_reuse')
  .refine(d => !d.collection?.responseRecovery || d.collection.pageValidation === 'artifact-proof-v1', 'read_response_recovery_requires_page_validation')
  .refine(d => !d.computerContinuation || d.resultValidation === 'artifact-proof-v1' && !d.collection && !d.reuse &&
    d.effect === (d.computerContinuation === 'continue' ? 'write' : 'read'), 'computer_continuation_contract_invalid')
  .refine(d => !d.computerInputAssurance || d.resultValidation === 'artifact-proof-v1' && !d.collection && !d.reuse, 'computer_input_assurance_contract_invalid');
export const ToolRefSchema = z.strictObject({ id, version: id });
export const SearchSchema = z.strictObject({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(20) });
export const ReadLimitSchema = z.number().int().min(256).max(65536);
export const WorkActorSchema = z.strictObject({ tenantId: id, principalId: id });

export function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
