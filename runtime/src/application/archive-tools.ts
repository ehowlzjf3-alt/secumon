import { z } from 'zod';
import type { Json, TaskSpec, ToolResult } from '../domain/model.js';
import type { Tool } from './ports.js';
import type { WorkActor } from './work-resources.js';
import { ArchiveDocumentSchema, ArchiveMutationSchema, ArchiveQuerySchema, type ArchiveDescriptor, type ArchiveMutationResult } from './archive-contracts.js';
import { ArchiveService } from './archive-service.js';
import { asJson } from './plan-validator.js';
import { frozen } from './resource-contracts.js';

const maximum = z.number().int().min(512).max(262144);
const GetSchema = z.strictObject({ id: ArchiveDocumentSchema.shape.id, maxBytes: maximum });
const SearchSchema = ArchiveQuerySchema.extend({ maxBytes: maximum }).strict();
const byteLength = (value: Json) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const mutationInputs = {
  register: ArchiveMutationSchema.options[0].omit({ kind: true, commandId: true }),
  revise: ArchiveMutationSchema.options[1].omit({ kind: true, commandId: true }),
  delete: ArchiveMutationSchema.options[2].omit({ kind: true, commandId: true }),
};

export function archiveMutationForTask(descriptor: ArchiveDescriptor, task: TaskSpec, workId: string, attemptId: string) {
  const operation = (Object.keys(mutationInputs) as (keyof typeof mutationInputs)[]).find(value => task.toolId === `${descriptor.id}.${value}`);
  if (!operation || task.toolVersion !== descriptor.version || task.effect !== 'write') throw new Error('archive_task_invalid');
  const input = mutationInputs[operation].parse(task.input);
  return ArchiveMutationSchema.parse({ ...input, kind: operation, commandId: JSON.stringify(['archive', workId, attemptId]) });
}
export function archiveMutationToolResult(provider: string, attemptId: string, receipt: ArchiveMutationResult): ToolResult {
  return { resultId: `${attemptId}:result`, attemptId, effectState: 'confirmed', status: 'success', coverage: 'complete',
    output: asJson({ kind: 'archive_mutation_receipt', provider, receipt }), evidence: [], artifacts: [], cursor: null, error: null };
}

export function createArchiveTools(service: ArchiveService, actor: WorkActor): Tool[] {
  const selectedActor = frozen(structuredClone(actor));
  const descriptor = service.descriptor;
  const reads: Tool[] = (['search', 'get'] as const).map(operation => {
    const id = `${descriptor.id}.${operation}`, schema = operation === 'search' ? SearchSchema : GetSchema;
    return {
      definition: { provider: descriptor.id, id, version: descriptor.version, effect: 'read', destination: descriptor.destination,
        labels: [...descriptor.labels], description: operation === 'search' ?
          'Search registered archive reference material. Returns title, path and source version; not verified Evidence and never automatically saved as personal memory.' :
          'Read the original text of a registered archive document by id. This is reference material, not verified Evidence. A too_large response requires a larger maxBytes.',
        inputSchema: asJson(z.toJSONSchema(schema, { target: 'draft-7' })), outputSchema: { type: 'object' } },
      async execute(task, context): Promise<ToolResult> {
        const base = { resultId: `${context.attemptId}:result`, attemptId: context.attemptId, effectState: 'none' as const,
          evidence: [], artifacts: [], cursor: null };
        context.signal.throwIfAborted(); service.authorize(selectedActor, context.policy);
        if (task.toolId !== id || task.toolVersion !== descriptor.version || task.effect !== 'read' || !context.policy.allowedTools.includes(id)) {
          throw new Error('archive_access_denied');
        }
        await context.authorize?.(); context.signal.throwIfAborted(); service.authorize(selectedActor, context.policy);
        let output: Json, maxBytes: number, partial = false;
        if (operation === 'search') {
          const input = SearchSchema.parse(task.input); maxBytes = input.maxBytes;
          const found = await service.search(selectedActor, { query: input.query, limit: input.limit }, context.signal);
          partial = found.truncated;
          output = asJson({ kind: 'archive_reference', provider: descriptor.id, documents: found.documents.map(({ body: _body, ...document }) => document), truncated: found.truncated });
        } else {
          const input = GetSchema.parse(task.input); maxBytes = input.maxBytes;
          output = asJson({ kind: 'archive_reference', provider: descriptor.id, document: await service.get(selectedActor, input.id, context.signal) });
        }
        await context.authorize?.(); context.signal.throwIfAborted(); service.authorize(selectedActor, context.policy);
        const bytes = byteLength(output);
        if (bytes > maxBytes) { partial = true; output = { kind: 'archive_reference', status: 'too_large', byteLength: bytes }; }
        return { ...base, status: partial ? 'partial' : 'success', coverage: partial ? 'partial' : 'complete', output, error: null };
      },
    };
  });
  if (!service.allowWrites) return reads;
  const writes: Tool[] = Object.entries(mutationInputs).map(([operation, schema]) => {
    const id = `${descriptor.id}.${operation}`;
    return {
      definition: { provider: descriptor.id, id, version: descriptor.version, effect: 'write', destination: descriptor.destination,
        labels: [...descriptor.labels], description: `Explicitly ${operation} an archive reference. Requires host write permission. ` +
          'Uses an attempt-bound command receipt; this does not create verified Evidence or personal memory. Unknown outcomes require effect reconciliation, not an automatic retry.',
        inputSchema: asJson(z.toJSONSchema(schema, { target: 'draft-7' })), outputSchema: { type: 'object' } },
      async execute(task, context): Promise<ToolResult> {
        const command = archiveMutationForTask(descriptor, task, context.workId, context.attemptId);
        if (task.toolId !== id || task.toolVersion !== descriptor.version || task.effect !== 'write' ||
          !context.policy.allowWrites || !context.policy.allowedTools.includes(id)) throw new Error('archive_access_denied');
        service.authorize(selectedActor, context.policy); context.signal.throwIfAborted();
        await context.authorize?.(); context.signal.throwIfAborted(); service.authorize(selectedActor, context.policy);
        const receipt = await service.mutate(selectedActor, command, context.signal);
        // Do not replace a confirmed late write with a fabricated cancellation. Receive/adopt recheck current authority.
        return archiveMutationToolResult(descriptor.id, context.attemptId, receipt);
      },
    };
  });
  return [...reads, ...writes];
}
