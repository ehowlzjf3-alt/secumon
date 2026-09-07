import { createHash, randomUUID } from 'node:crypto';
import type { KnowledgeRecord } from '../domain/knowledge.js';
import type { PersonalMemoryImportOptions, PersonalMemoryNamespaceSnapshot, PersonalMemorySeedRecord,
  PersonalMemorySnapshotReader, PersonalMemoryMigrationScope } from '../application/personal-memory-migration-contracts.js';
import { documentDigest } from '../infrastructure/document-knowledge-codec.js';
import { importScopeOrderKey, utf8Compare } from '../infrastructure/document-knowledge-import-codec.js';
import { sha256 } from '../infrastructure/digest.js';
import { correctedRecord, personalRecord } from './personal-knowledge-storage-helpers.js';

export function migrationSourceReferences(record: KnowledgeRecord) {
  return record.sources.map(source => {
    if (source.type !== 'session_user_receipt') throw new Error('personal_fixture_required');
    return { type: source.type, session: source.session, messageId: source.messageId, sequence: source.sequence, receiptDigest: source.receiptDigest };
  });
}
export function migrationSeed(history: KnowledgeRecord[]): PersonalMemorySeedRecord {
  const record = history.at(-1)!;
  return { record, sourceRecordJsonDigest: sha256(Buffer.from(JSON.stringify(record))), receipts: history.map((current, index) => ({
    commandId: `${record.id}-command-${index + 1}`, digest: documentDigest({ originalCommand: record.id, revision: index + 1 }), revision: index + 1,
    // Deliberately retain noncanonical whitespace to prove audit bytes are not reserialized during import.
    auditJson: JSON.stringify({ expectedRevision: index, revision: index + 1, contentRevision: current.contentRevision,
      previousSources: index ? migrationSourceReferences(history[index - 1]!) : [], sources: migrationSourceReferences(current) }, null, 2),
  })) };
}
const streamDigest = (values: unknown[]) => {
  const hash = createHash('sha256'); for (const value of values) hash.update(documentDigest(value) + '\n'); return hash.digest('hex');
};
export function migrationReader(agentId: string, sets: { scope: PersonalMemoryMigrationScope; records: PersonalMemorySeedRecord[] }[]): PersonalMemorySnapshotReader {
  const ordered = sets.toSorted((a, b) => utf8Compare(importScopeOrderKey(a.scope), importScopeOrderKey(b.scope)));
  const namespaces: PersonalMemoryNamespaceSnapshot[] = ordered.map(value => {
    const records = value.records.toSorted((a, b) => utf8Compare(a.record.id, b.record.id)); value.records = records;
    const receipts = records.flatMap(seed => seed.receipts.map(receipt => ({ id: seed.record.id, ...receipt })));
    return { scope: value.scope, records: records.length, receipts: receipts.length, audits: receipts.length,
      activeRecords: records.filter(seed => seed.record.status === 'active').length,
      head: { revision: receipts.length, cursor: receipts.length, error: null },
      currentRecordsDigest: streamDigest(records.map(seed => ({ id: seed.record.id, sourceRecordJsonDigest: seed.sourceRecordJsonDigest }))),
      receiptsDigest: streamDigest(receipts), indexDigest: streamDigest(records.filter(seed => seed.record.status === 'active').map(seed => ({
        id: seed.record.id, document: `${seed.record.title}\n${seed.record.body}`.normalize('NFC').toLocaleLowerCase('en-US'), sourceRecordJsonDigest: seed.sourceRecordJsonDigest }))) };
  });
  return { snapshot: { agentId, ownerDigest: documentDigest({ fixtureOwner: agentId }), knowledgeSchemaVersion: 2, scopedSchemaVersion: 1,
    workDigest: documentDigest({ unchangedWork: true }), snapshotDigest: documentDigest(namespaces), namespaces },
    *records(scope) {
      const found = ordered.find(value => documentDigest(value.scope) === documentDigest(scope));
      if (!found) throw new Error('missing_fixture_namespace');
      for (const seed of found.records) yield structuredClone(seed);
    } };
}
export function documentImportFixture(agentId: string, options?: PersonalMemoryImportOptions) {
  const scope: PersonalMemoryMigrationScope = { tenantId: 'tenant-a', agentId, principalId: 'user-a', partition: 'personal', namespace: 'personal' };
  const first = { ...personalRecord(agentId), id: 'memory-a' }, second = correctedRecord(first), third = correctedRecord(second), fourth = correctedRecord(third);
  const obsolete = { ...personalRecord(agentId), id: 'memory-b' };
  const forgotten: KnowledgeRecord = { ...obsolete, status: 'deleted', revision: 2, updatedAt: obsolete.updatedAt + 1, body: '',
    sources: obsolete.sources.map(source => source.type === 'session_user_receipt' ? { ...source, quote: '' } : source) };
  const seeds = [migrationSeed([first, second, third, fourth]), migrationSeed([obsolete, forgotten])];
  return { scope, seeds, first, fourth, forgotten, reader: migrationReader(agentId, [{ scope, records: seeds }]),
    options: options ?? { operationId: randomUUID(), agentId, storeId: randomUUID(), backupDigest: 'b'.repeat(64) } };
}
