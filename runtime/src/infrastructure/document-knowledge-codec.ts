import { z } from 'zod';
import { parseKnowledge } from '../application/knowledge-contracts.js';
import type { Json } from '../domain/model.js';
import type { KnowledgeRecord } from '../domain/knowledge.js';
import { canonical, sha256 } from './digest.js';

export class DocumentKnowledgeError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) { super(code, options); }
}
export const documentLimits = Object.freeze({ entries: 4096, bytes: 64 * 1024 * 1024, file: 256 * 1024,
  pending: 512, pendingBytes: 64 * 1024 * 1024, roots: 4096, retries: 8 });
export const documentName = z.string().min(1).max(160).refine(value => value === value.trim() && !/[\x00-\x1f\x7f]/.test(value));
export const documentHash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const documentNamespaceSchema = z.strictObject({ tenantId: documentName, agentId: documentName, principalId: documentName,
  partition: z.literal('personal'), namespace: z.literal('personal') });
export type DocumentNamespace = z.infer<typeof documentNamespaceSchema>;
export const indexErrors = ['index_read_failed', 'index_capacity_exceeded', 'index_rebuild_failed'] as const;
export type DocumentChange = { kind: 'record'; expectedRevision: number; commandId: string; commandDigest: string; next: KnowledgeRecord } |
  { kind: 'index'; action: 'rebuild' } | { kind: 'index'; action: 'error'; code: typeof indexErrors[number] };
export interface DocumentEvent { schemaVersion: 1 | 2; scope: DocumentNamespace; sequence: number; previous: string | null; change: DocumentChange }
const payloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('record'), expectedRevision: count, commandId: documentName, commandDigest: documentHash, metadata: z.record(z.string(), z.unknown()) }),
  z.strictObject({ kind: z.literal('index'), action: z.enum(['rebuild', 'error']), code: z.enum(indexErrors).optional() }),
]);
const envelopeSchema = z.strictObject({ schemaVersion: z.union([z.literal(1), z.literal(2)]), scope: documentNamespaceSchema, sequence: count.positive(),
  previous: documentHash.nullable(), payload: payloadSchema, digest: documentHash });
const prefix = (version: 1 | 2) => `<!-- secumon-memory-v${version}\n`, separator = '\n-->\n';
export function documentDigest(value: unknown): string { return sha256(canonical(JSON.parse(JSON.stringify(value)) as Json)); }
export const documentNamespaceName = (scope: DocumentNamespace) => `ns-${documentDigest(scope)}`;
export const documentEventName = (sequence: number) => `${String(sequence).padStart(8, '0')}.md`;
export function validateDocumentRecord(record: KnowledgeRecord, scope: DocumentNamespace) {
  if (record.tenantId !== scope.tenantId || record.owner?.agentId !== scope.agentId || record.owner.principalId !== scope.principalId ||
    record.authorId !== scope.principalId || record.kind !== 'personal' || record.namespace !== scope.namespace || record.scope !== 'personal') {
    throw new DocumentKnowledgeError('knowledge_scope_mismatch');
  }
}
export function validateDocumentTransition(old: KnowledgeRecord | undefined, next: KnowledgeRecord, expectedRevision: number) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || next.revision !== expectedRevision + 1) throw new DocumentKnowledgeError('invalid_knowledge_commit');
  if (old && (old.namespace !== next.namespace || old.scope !== next.scope || old.authorId !== next.authorId || old.createdAt !== next.createdAt ||
    old.updatedAt > next.updatedAt || next.contentRevision < old.contentRevision || next.contentRevision > old.contentRevision + 1 ||
    old.status !== 'active' && next.status === 'active')) throw new DocumentKnowledgeError('invalid_knowledge_transition');
}
/** The body field is Markdown; provenance may repeat quotes. Metadata is never executable. */
export function encodeDocumentEvent(event: DocumentEvent): Buffer {
  let body = ''; let payload: z.infer<typeof payloadSchema>;
  if (event.change.kind === 'record') {
    const next = parseKnowledge(event.change.next); validateDocumentRecord(next, event.scope);
    const { body: text, ...metadata } = next; body = text;
    payload = { kind: 'record', expectedRevision: event.change.expectedRevision, commandId: event.change.commandId,
      commandDigest: event.change.commandDigest, metadata };
  } else payload = event.change;
  const value = { schemaVersion: event.schemaVersion, scope: event.scope, sequence: event.sequence, previous: event.previous, payload };
  const envelope = envelopeSchema.parse({ ...value, digest: documentDigest({ ...value, body }) });
  const bytes = Buffer.from(prefix(event.schemaVersion) + JSON.stringify(envelope) + separator + body);
  if (bytes.length > documentLimits.file) throw new DocumentKnowledgeError('document_knowledge_limit_exceeded');
  return bytes;
}
export function decodeDocumentEvent(bytes: Buffer): DocumentEvent {
  if (bytes.length > documentLimits.file) throw new DocumentKnowledgeError('document_knowledge_limit_exceeded');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), version = text.startsWith(prefix(2)) ? 2 : 1;
    const start = prefix(version), split = text.indexOf(separator, start.length);
    if (!text.startsWith(start) || split < 0) throw new Error('invalid_document_envelope');
    const header = envelopeSchema.parse(JSON.parse(text.slice(start.length, split))), body = text.slice(split + separator.length);
    if (header.schemaVersion !== version) throw new Error('invalid_document_version');
    const { digest, ...value } = header;
    if (documentDigest({ ...value, body }) !== digest) throw new Error('invalid_document_digest');
    let change: DocumentChange;
    if (header.payload.kind === 'record') {
      if (Object.hasOwn(header.payload.metadata, 'body')) throw new Error('duplicate_document_body');
      const next = parseKnowledge({ ...header.payload.metadata, body }); validateDocumentRecord(next, header.scope);
      validateDocumentTransition(undefined, next, header.payload.expectedRevision);
      change = { kind: 'record', expectedRevision: header.payload.expectedRevision, commandId: header.payload.commandId,
        commandDigest: header.payload.commandDigest, next };
    } else {
      if (body !== '' || header.payload.action === 'rebuild' && header.payload.code !== undefined || header.payload.action === 'error' && header.payload.code === undefined) throw new Error('invalid_index_record');
      change = header.payload.action === 'rebuild' ? { kind: 'index', action: 'rebuild' } : { kind: 'index', action: 'error', code: header.payload.code! };
    }
    return { schemaVersion: header.schemaVersion, scope: header.scope, sequence: header.sequence, previous: header.previous, change };
  } catch (cause) { throw new DocumentKnowledgeError('document_knowledge_record_invalid', { cause }); }
}
