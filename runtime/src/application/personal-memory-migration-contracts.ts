import { z } from 'zod';
import type { KnowledgeRecord } from '../domain/knowledge.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const name = z.string().min(1).max(160).refine(value => value === value.trim() && !/[\x00-\x1f\x7f]/.test(value));
export const PersonalMemoryMigrationScopeSchema = z.strictObject({ tenantId: name, agentId: name,
  principalId: name, partition: z.literal('personal'), namespace: z.literal('personal') });
export type PersonalMemoryMigrationScope = z.infer<typeof PersonalMemoryMigrationScopeSchema>;
export const PersonalMemoryNamespaceSnapshotSchema = z.strictObject({ scope: PersonalMemoryMigrationScopeSchema,
  records: count, receipts: count, audits: count, activeRecords: count,
  head: z.strictObject({ revision: count, cursor: count, error: z.null() }),
  currentRecordsDigest: digest, receiptsDigest: digest, indexDigest: digest });
export type PersonalMemoryNamespaceSnapshot = z.infer<typeof PersonalMemoryNamespaceSnapshotSchema>;
export const PersonalMemorySnapshotSchema = z.strictObject({ agentId: z.uuid(), ownerDigest: digest,
  knowledgeSchemaVersion: z.literal(2), scopedSchemaVersion: z.literal(1),
  snapshotDigest: digest, workDigest: digest,
  namespaces: z.array(PersonalMemoryNamespaceSnapshotSchema).max(2048) });
export type PersonalMemorySnapshot = z.infer<typeof PersonalMemorySnapshotSchema>;
export interface PersonalMemoryImportedReceipt { commandId: string; digest: string; revision: number; auditJson: string }
export interface PersonalMemorySeedRecord { record: KnowledgeRecord; sourceRecordJsonDigest: string; receipts: PersonalMemoryImportedReceipt[] }

/** Host-only, repeatable reads from one fixed snapshot. Never exposed as a model memory tool. */
export interface PersonalMemorySnapshotReader {
  readonly snapshot: PersonalMemorySnapshot;
  records(scope: PersonalMemoryMigrationScope): Iterable<PersonalMemorySeedRecord>;
}
export const PersonalMemoryFenceSchema = z.strictObject({ schemaVersion: z.literal(1), operationId: z.uuid(),
  agentId: z.uuid(), targetStoreId: z.uuid(), snapshotDigest: digest, ownerDigest: digest, workDigest: digest });
export type PersonalMemoryFence = z.infer<typeof PersonalMemoryFenceSchema>;
export const PersonalMemoryImportReceiptSchema = z.strictObject({ operationId: z.uuid(), agentId: z.uuid(), storeId: z.uuid(),
  snapshotDigest: digest, manifestDigest: digest, namespaceCount: count, recordCount: count, receiptCount: count, bytes: count });
export type PersonalMemoryImportReceipt = z.infer<typeof PersonalMemoryImportReceiptSchema>;
export interface PersonalMemoryImportOptions { operationId: string; agentId: string; storeId: string; backupDigest: string }

export const PersonalMemoryMigrationOptionsSchema = z.strictObject({
  directory: z.string().min(1).max(4096), source: z.string().min(1).max(4096), target: z.string().min(1).max(4096),
  operationId: z.uuid(), targetStoreId: z.uuid(), backupDirectory: z.string().min(1).max(4096),
  from: z.literal('sqlite'), to: z.literal('documents'), scope: z.literal('all-personal'),
});
export type PersonalMemoryMigrationOptions = z.infer<typeof PersonalMemoryMigrationOptionsSchema>;
export class PersonalMemoryMigrationError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) { super(code, options); }
}
