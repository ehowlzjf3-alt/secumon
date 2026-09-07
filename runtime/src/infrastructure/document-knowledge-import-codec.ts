import { z } from 'zod';
import { parseKnowledge } from '../application/knowledge-contracts.js';
import { SessionScopeSchema } from '../application/session-base-contracts.js';
import type { KnowledgeRecord } from '../domain/knowledge.js';
import { sha256 } from './digest.js';
import { DocumentKnowledgeError, documentDigest, documentHash, documentLimits, documentName, documentNamespaceSchema,
  validateDocumentRecord, type DocumentNamespace } from './document-knowledge-codec.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const uuid = z.string().uuid();
export const importedReceiptSchema = z.strictObject({ commandId: documentName, digest: documentHash,
  revision: count.positive(), auditJson: z.string().min(1).max(documentLimits.file) });
export type ImportedKnowledgeReceipt = z.infer<typeof importedReceiptSchema>;
export const importedHeadSchema = z.strictObject({ revision: count, cursor: count, error: z.null() });
const seedRecordSchema = z.strictObject({ kind: z.literal('seed_record'), operationId: uuid, snapshotDigest: documentHash,
  sourceRecordJsonDigest: documentHash, metadata: z.record(z.string(), z.unknown()), receipts: z.array(importedReceiptSchema).min(1).max(documentLimits.entries) });
const seedHeadSchema = z.strictObject({ kind: z.literal('seed_head'), operationId: uuid, snapshotDigest: documentHash,
  records: count, receipts: count, audits: count, activeRecords: count, head: importedHeadSchema });
const seedEnvelopeSchema = z.strictObject({ schemaVersion: z.literal(2), scope: documentNamespaceSchema,
  sequence: count.positive().max(documentLimits.entries), previous: documentHash.nullable(),
  payload: z.discriminatedUnion('kind', [seedRecordSchema, seedHeadSchema]), digest: documentHash });
export type DocumentSeedChange = { kind: 'seed_record'; operationId: string; snapshotDigest: string;
  sourceRecordJsonDigest: string; next: KnowledgeRecord; receipts: ImportedKnowledgeReceipt[] } | z.infer<typeof seedHeadSchema>;
export interface DocumentSeedEvent { schemaVersion: 2; scope: DocumentNamespace; sequence: number; previous: string | null; change: DocumentSeedChange }
export const importNamespaceSchema = z.strictObject({ scope: documentNamespaceSchema,
  records: count, receipts: count, audits: count, activeRecords: count, head: importedHeadSchema,
  currentRecordsDigest: documentHash, receiptsDigest: documentHash, indexDigest: documentHash,
  prefix: z.strictObject({ entries: count.positive().max(documentLimits.entries - 1),
    bytes: count.max(documentLimits.bytes - documentLimits.file), lastDigest: documentHash }) });
export const documentImportManifestSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('sqlite-personal-snapshot-v1'),
  operationId: uuid, agentId: documentName, storeId: documentName, snapshotDigest: documentHash,
  source: z.strictObject({ mode: z.literal('agent'), ownerDigest: documentHash, knowledgeSchemaVersion: z.literal(2),
    scopedSchemaVersion: z.literal(1), backupDigest: documentHash }),
  namespaces: z.array(importNamespaceSchema).max(Math.floor((documentLimits.roots - 3) / 2)) });
export type DocumentImportManifest = z.infer<typeof documentImportManifestSchema>;
export type DocumentImportNamespace = z.infer<typeof importNamespaceSchema>;
export const documentImportedFormatSchema = z.strictObject({ schemaVersion: z.literal(2), format: z.literal('immutable-markdown-namespace-v2'),
  initialImport: z.strictObject({ kind: z.literal('sqlite-personal-snapshot-v1'), operationId: uuid, snapshotDigest: documentHash, manifestDigest: documentHash }) });
export type DocumentImportedFormat = z.infer<typeof documentImportedFormatSchema>;
export type DocumentStoreDescriptor = { schemaVersion: 1 } | { schemaVersion: 2; format: DocumentImportedFormat; manifest: DocumentImportManifest };

const sourceRef = z.strictObject({ type: z.literal('session_user_receipt'), session: SessionScopeSchema,
  messageId: documentName, sequence: count.positive(), receiptDigest: documentHash });
const auditSchema = z.strictObject({ expectedRevision: count, revision: count.positive(), contentRevision: count.positive(),
  previousSources: z.array(sourceRef).max(64), sources: z.array(sourceRef).min(1).max(64) });
export const utf8Compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
export const importScopeOrderKey = (scope: DocumentNamespace) => JSON.stringify({ agentId: scope.agentId, namespace: scope.namespace,
  partition: scope.partition, principalId: scope.principalId, tenantId: scope.tenantId });
function invalid(cause?: unknown): never { throw new DocumentKnowledgeError('document_knowledge_import_invalid', cause === undefined ? undefined : { cause }); }
export function checkedImportSum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) { count.parse(value); total += value; if (!Number.isSafeInteger(total)) invalid(); }
  return total;
}
/** These are the audit shapes emitted by the current personal-memory service, not reconstructed historical bodies. */
export function validateImportedReceipts(record: KnowledgeRecord, scope: DocumentNamespace, receipts: ImportedKnowledgeReceipt[]): void {
  validateDocumentRecord(record, scope);
  if (receipts.length !== record.revision || !receipts.length) invalid();
  if (receipts.length > documentLimits.entries) throw new DocumentKnowledgeError('document_knowledge_limit_exceeded');
  let previousSources: z.infer<typeof sourceRef>[] = [], contentRevision = 0, auditBytes = 0;
  const commands = new Set<string>();
  for (const [index, raw] of receipts.entries()) {
    const receipt = importedReceiptSchema.parse(raw);
    auditBytes += Buffer.byteLength(receipt.auditJson);
    if (auditBytes > documentLimits.file) throw new DocumentKnowledgeError('document_knowledge_limit_exceeded');
    if (receipt.revision !== index + 1 || commands.has(receipt.commandId)) invalid();
    commands.add(receipt.commandId);
    let audit: z.infer<typeof auditSchema>;
    try { audit = auditSchema.parse(JSON.parse(receipt.auditJson)); } catch (cause) { invalid(cause); }
    if (audit.expectedRevision !== index || audit.revision !== index + 1 || audit.contentRevision < contentRevision ||
      audit.contentRevision > contentRevision + 1 || audit.contentRevision > audit.revision ||
      documentDigest(audit.previousSources) !== documentDigest(previousSources) ||
      [...audit.previousSources, ...audit.sources].some(source => source.session.tenantId !== scope.tenantId ||
        source.session.agentId !== scope.agentId || source.session.principalId !== scope.principalId)) invalid();
    previousSources = audit.sources; contentRevision = audit.contentRevision;
  }
  const current = record.sources.map(source => source.type === 'session_user_receipt' ?
    { type: source.type, session: source.session, messageId: source.messageId, sequence: source.sequence, receiptDigest: source.receiptDigest } : null);
  if (contentRevision !== record.contentRevision || documentDigest(previousSources) !== documentDigest(current)) invalid();
}
const prefix = '<!-- secumon-memory-v2\n', separator = '\n-->\n';
export function encodeDocumentSeed(event: DocumentSeedEvent): Buffer {
  let body = ''; let payload: z.infer<typeof seedRecordSchema> | z.infer<typeof seedHeadSchema>;
  if (event.change.kind === 'seed_record') {
    const next = parseKnowledge(event.change.next); validateImportedReceipts(next, event.scope, event.change.receipts);
    const { body: text, ...metadata } = next; body = text;
    const { next: _next, ...change } = event.change; payload = { ...change, metadata };
  } else payload = event.change;
  const value = { schemaVersion: 2 as const, scope: event.scope, sequence: event.sequence, previous: event.previous, payload };
  const envelope = seedEnvelopeSchema.parse({ ...value, digest: documentDigest({ ...value, body }) });
  const bytes = Buffer.from(prefix + JSON.stringify(envelope) + separator + body);
  if (bytes.length > documentLimits.file) throw new DocumentKnowledgeError('document_knowledge_limit_exceeded');
  return bytes;
}
export function decodeDocumentSeed(bytes: Buffer): DocumentSeedEvent {
  if (bytes.length > documentLimits.file) throw new DocumentKnowledgeError('document_knowledge_limit_exceeded');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), split = text.indexOf(separator, prefix.length);
    if (!text.startsWith(prefix) || split < 0) invalid();
    const envelope = seedEnvelopeSchema.parse(JSON.parse(text.slice(prefix.length, split))), body = text.slice(split + separator.length);
    const { digest, ...value } = envelope;
    if (digest !== documentDigest({ ...value, body })) invalid();
    let change: DocumentSeedChange;
    if (envelope.payload.kind === 'seed_record') {
      if (Object.hasOwn(envelope.payload.metadata, 'body')) invalid();
      const next = parseKnowledge({ ...envelope.payload.metadata, body }); validateImportedReceipts(next, envelope.scope, envelope.payload.receipts);
      const { metadata: _metadata, ...payload } = envelope.payload; change = { ...payload, next };
    } else { if (body !== '') invalid(); change = envelope.payload; }
    return { schemaVersion: 2, scope: envelope.scope, sequence: envelope.sequence, previous: envelope.previous, change };
  } catch (cause) { if (cause instanceof DocumentKnowledgeError) throw cause; invalid(cause); }
}
export function encodeDocumentImportManifest(value: DocumentImportManifest): Buffer {
  const manifest = documentImportManifestSchema.parse(value); validateDocumentImportManifest(manifest);
  const bytes = Buffer.from(JSON.stringify(manifest));
  if (bytes.length > documentLimits.file) throw new DocumentKnowledgeError('document_knowledge_limit_exceeded');
  return bytes;
}
export function decodeDocumentImportManifest(bytes: Buffer): DocumentImportManifest {
  if (bytes.length > documentLimits.file) throw new DocumentKnowledgeError('document_knowledge_limit_exceeded');
  try {
    const manifest = documentImportManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    validateDocumentImportManifest(manifest); return manifest;
  } catch (cause) { if (cause instanceof DocumentKnowledgeError) throw cause; invalid(cause); }
}
export function validateDocumentImportManifest(manifest: DocumentImportManifest): void {
  let prior: string | undefined;
  for (const ns of manifest.namespaces) {
    const key = importScopeOrderKey(ns.scope);
    if (ns.scope.agentId !== manifest.agentId || prior !== undefined && utf8Compare(prior, key) >= 0 ||
      ns.records + 1 !== ns.prefix.entries || ns.activeRecords > ns.records || ns.receipts !== ns.audits ||
      ns.head.revision !== ns.receipts || ns.head.cursor !== ns.head.revision) invalid();
    prior = key;
  }
}
export function importedStoreFormat(manifest: DocumentImportManifest, bytes: Buffer): DocumentImportedFormat {
  return { schemaVersion: 2, format: 'immutable-markdown-namespace-v2', initialImport: {
    kind: 'sqlite-personal-snapshot-v1', operationId: manifest.operationId, snapshotDigest: manifest.snapshotDigest, manifestDigest: sha256(bytes) } };
}
