import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { PersonalMemoryImportReceiptSchema, PersonalMemorySnapshotSchema, type PersonalMemoryImportOptions,
  type PersonalMemoryImportReceipt, type PersonalMemorySnapshotReader, type PersonalMemoryNamespaceSnapshot } from '../application/personal-memory-migration-contracts.js';
import { parseKnowledge } from '../application/knowledge-contracts.js';
import { sha256 } from './digest.js';
import { FileBoundaryFault, type MetadataDirectory } from './host-metadata-files.js';
import { FileMutationFault, type FilePublicationResult } from './host-file-mutations.js';
import { DocumentFiles, documentNamesEqual, documentPending, inspectDocumentImportRoot, inspectUnpreparedDocumentImportRoot, prepareDocumentImportRoot,
  type DocumentKnowledgeBinding } from './document-knowledge-owner.js';
import { DocumentKnowledgeError, documentDigest, documentEventName, documentHash, documentLimits, documentNamespaceName,
  type DocumentNamespace } from './document-knowledge-codec.js';
import { checkedImportSum, decodeDocumentImportManifest, decodeDocumentSeed,
  encodeDocumentImportManifest, encodeDocumentSeed, importedStoreFormat, importScopeOrderKey, utf8Compare,
  type DocumentImportManifest, type DocumentImportNamespace } from './document-knowledge-import-codec.js';

const optionsSchema = z.strictObject({ operationId: z.uuid(), agentId: z.uuid(), storeId: z.uuid(), backupDigest: documentHash });
type PreparedImport = { manifest: DocumentImportManifest; bytes: Buffer; receipt: PersonalMemoryImportReceipt };
const witnessName = (sequence: number) => `${String(sequence).padStart(8, '0')}.json`;
const witnessBytes = (scope: DocumentNamespace, sequence: number, digest: string) => Buffer.from(JSON.stringify({ scope, sequence, digest }));
function invalid(code = 'document_knowledge_import_invalid'): never { throw new DocumentKnowledgeError(code); }
function sequenceNames(names: string[], extension: 'md' | 'json'): string[] {
  const result = names.filter(name => !documentPending.test(name));
  if (result.length > documentLimits.entries) invalid('document_knowledge_limit_exceeded');
  if (result.some((name, index) => name !== (extension === 'md' ? documentEventName(index + 1) : witnessName(index + 1)))) invalid('document_knowledge_sequence_invalid');
  return result;
}
function* seedFiles(reader: PersonalMemorySnapshotReader, ns: PersonalMemoryNamespaceSnapshot, options: PersonalMemoryImportOptions): Generator<Buffer> {
  let sequence = 0, previous: string | null = null, receipts = 0, active = 0, priorId: string | undefined;
  const recordDigest = createHash('sha256'), receiptDigest = createHash('sha256');
  for (const seed of reader.records(ns.scope)) {
    if (sequence >= documentLimits.entries - 2 || sequence >= ns.records) invalid('document_knowledge_limit_exceeded');
    const record = parseKnowledge(seed.record); documentHash.parse(seed.sourceRecordJsonDigest);
    if (priorId !== undefined && utf8Compare(priorId, record.id) >= 0) invalid(); priorId = record.id;
    const bytes = encodeDocumentSeed({ schemaVersion: 2, scope: ns.scope, sequence: ++sequence, previous,
      change: { kind: 'seed_record', operationId: options.operationId, snapshotDigest: reader.snapshot.snapshotDigest,
        sourceRecordJsonDigest: seed.sourceRecordJsonDigest, next: record, receipts: seed.receipts } });
    recordDigest.update(documentDigest({ id: record.id, sourceRecordJsonDigest: seed.sourceRecordJsonDigest }) + '\n');
    for (const receipt of seed.receipts) receiptDigest.update(documentDigest({ id: record.id, ...receipt }) + '\n');
    receipts = checkedImportSum([receipts, seed.receipts.length]); if (record.status === 'active') active++;
    previous = sha256(bytes); yield bytes;
  }
  if (sequence !== ns.records || receipts !== ns.receipts || receipts !== ns.audits || active !== ns.activeRecords ||
    ns.head.revision !== receipts || ns.head.cursor !== receipts || ns.head.error !== null ||
    recordDigest.digest('hex') !== ns.currentRecordsDigest || receiptDigest.digest('hex') !== ns.receiptsDigest) invalid();
  yield encodeDocumentSeed({ schemaVersion: 2, scope: ns.scope, sequence: sequence + 1, previous,
    change: { kind: 'seed_head', operationId: options.operationId, snapshotDigest: reader.snapshot.snapshotDigest,
      records: sequence, receipts, audits: receipts, activeRecords: active, head: ns.head } });
}
function prepare(reader: PersonalMemorySnapshotReader, raw: PersonalMemoryImportOptions): PreparedImport {
  const options = optionsSchema.parse(raw), snapshot = PersonalMemorySnapshotSchema.parse(reader.snapshot);
  if (snapshot.agentId !== options.agentId || snapshot.snapshotDigest !== documentDigest(snapshot.namespaces)) invalid();
  const namespaces: DocumentImportNamespace[] = []; let previousScope: string | undefined;
  for (const ns of snapshot.namespaces) {
    if (namespaces.length >= Math.floor((documentLimits.roots - 3) / 2)) invalid('document_knowledge_limit_exceeded');
    const key = importScopeOrderKey(ns.scope);
    if (ns.scope.agentId !== options.agentId || previousScope !== undefined && utf8Compare(previousScope, key) >= 0) invalid(); previousScope = key;
    let entries = 0, total = 0, lastDigest = '';
    for (const bytes of seedFiles(reader, ns, options)) {
      entries++; total += bytes.length; lastDigest = sha256(bytes);
      if (entries >= documentLimits.entries || total > documentLimits.bytes - documentLimits.file) invalid('document_knowledge_limit_exceeded');
    }
    namespaces.push({ ...ns, prefix: { entries, bytes: total, lastDigest } });
  }
  const manifest: DocumentImportManifest = { schemaVersion: 1, kind: 'sqlite-personal-snapshot-v1', operationId: options.operationId,
    agentId: options.agentId, storeId: options.storeId, snapshotDigest: snapshot.snapshotDigest,
    source: { mode: 'agent', ownerDigest: snapshot.ownerDigest, knowledgeSchemaVersion: 2, scopedSchemaVersion: 1, backupDigest: options.backupDigest }, namespaces };
  const bytes = encodeDocumentImportManifest(manifest);
  const receipt = PersonalMemoryImportReceiptSchema.parse({ operationId: options.operationId, agentId: options.agentId, storeId: options.storeId,
    snapshotDigest: snapshot.snapshotDigest, manifestDigest: sha256(bytes), namespaceCount: namespaces.length,
    recordCount: checkedImportSum(namespaces.map(ns => ns.records)), receiptCount: checkedImportSum(namespaces.map(ns => ns.receipts)),
    bytes: checkedImportSum(namespaces.map(ns => ns.prefix.bytes)) });
  return { manifest, bytes, receipt };
}
/** Validates bounded deterministic seed bytes without touching the target. bytes counts canonical Markdown, not a physical filesystem reservation. */
export function previewDocumentKnowledgeImport(reader: PersonalMemorySnapshotReader, options: PersonalMemoryImportOptions): PersonalMemoryImportReceipt {
  return prepare(reader, options).receipt;
}
function afterPublication(stage: string, action: () => void, publication: FilePublicationResult) {
  try { action(); } catch (error) {
    if (error instanceof FileMutationFault) throw error;
    throw new FileMutationFault('publish', stage, publication, [{ stage, error }]);
  }
}
function importedBarrier(action: () => void): void {
  try { action(); } catch (error) {
    if (error instanceof FileMutationFault) throw error;
    throw new FileMutationFault('publish', 'knowledge_import_barrier', { publication: 'published', created: false,
      fileSynced: false, directorySynced: false, cleanup: 'not_needed' }, [{ stage: 'knowledge_import_barrier', error }]);
  }
}
function publishExact(files: DocumentFiles, path: string, ref: MetadataDirectory, name: string, bytes: Buffer): FilePublicationResult {
  const result = files.scope.publish(ref, name, bytes);
  afterPublication('knowledge_import_verify', () => {
    if (!files.read(path, ref, name, files.names(path, ref)).equals(bytes)) invalid('document_knowledge_import_conflict');
    files.sync(ref); files.check(path, ref);
  }, result);
  return result;
}
function importNamespace(files: DocumentFiles, reader: PersonalMemorySnapshotReader, ns: DocumentImportNamespace, options: PersonalMemoryImportOptions): void {
  // Hold at most one bounded namespace. A reader changing between preview and this pass cannot poison an immutable target prefix.
  const planned: Buffer[] = []; let plannedBytes = 0;
  for (const bytes of seedFiles(reader, ns, options)) {
    planned.push(bytes); plannedBytes += bytes.length;
    if (planned.length > ns.prefix.entries || plannedBytes > documentLimits.bytes - documentLimits.file) invalid('document_knowledge_limit_exceeded');
  }
  if (planned.length !== ns.prefix.entries || plannedBytes !== ns.prefix.bytes || sha256(planned.at(-1)!) !== ns.prefix.lastDigest) invalid('document_knowledge_import_conflict');
  const path = join(files.directory, documentNamespaceName(ns.scope)), witnessPath = join(files.directory, `witness-${documentDigest(ns.scope)}`);
  let ref = files.directoryRef(path), witness = files.directoryRef(witnessPath);
  const names = ref ? files.names(path, ref) : [], witnesses = witness ? files.names(witnessPath, witness) : [];
  const normal = sequenceNames(names, 'md'), recorded = sequenceNames(witnesses, 'json');
  if (normal.length > ns.prefix.entries || recorded.length > normal.length) invalid('document_knowledge_history_missing');
  if (ref) files.pending(path, ref, names); if (witness) files.pending(witnessPath, witness, witnesses);
  let sequence = 0;
  for (const bytes of planned) {
    const index = sequence++, name = documentEventName(sequence), seal = witnessBytes(ns.scope, sequence, sha256(bytes));
    if (index < normal.length) {
      if (!files.read(path, ref!, name, names).equals(bytes)) invalid('document_knowledge_import_conflict');
    } else {
      ref ??= files.directoryRef(path, true)!;
      publishExact(files, path, ref, name, bytes);
    }
    if (index < recorded.length) {
      if (!files.read(witnessPath, witness!, witnessName(sequence), witnesses, 4096).equals(seal)) invalid('document_knowledge_witness_invalid');
    } else {
      // A complete immutable seed file is the publication point. Missing witness suffixes are recoverable; missing canonical files are not.
      try {
        witness ??= files.directoryRef(witnessPath, true)!;
        publishExact(files, witnessPath, witness, witnessName(sequence), seal);
      } catch (error) {
        if (error instanceof FileMutationFault && error.status.publication !== 'not_published') throw error;
        throw new FileMutationFault('publish', 'knowledge_import_witness', { publication: 'published', created: false,
          fileSynced: false, directorySynced: false, cleanup: 'not_needed' }, [{ stage: 'knowledge_import_witness', error }]);
      }
    }
  }
  verifyPrefix(files, ns, { operationId: options.operationId, snapshotDigest: reader.snapshot.snapshotDigest }, false);
}
/** Validates exact immutable seed prefix and witnesses. This never invents missing canonical data. */
function verifyPrefix(files: DocumentFiles, ns: DocumentImportNamespace, identity: { operationId: string; snapshotDigest: string }, allowTail: boolean): void {
  const path = join(files.directory, documentNamespaceName(ns.scope)), witnessPath = join(files.directory, `witness-${documentDigest(ns.scope)}`);
  const ref = files.directoryRef(path), witness = files.directoryRef(witnessPath);
  if (!ref || !witness) invalid('document_knowledge_history_missing');
  const names = files.names(path, ref), witnessNames = files.names(witnessPath, witness), normal = sequenceNames(names, 'md'), recorded = sequenceNames(witnessNames, 'json');
  if (normal.length < ns.prefix.entries || recorded.length < ns.prefix.entries || !allowTail &&
    (normal.length !== ns.prefix.entries || recorded.length !== ns.prefix.entries)) invalid('document_knowledge_history_missing');
  files.pending(path, ref, names); files.pending(witnessPath, witness, witnessNames);
  let previous: string | null = null, total = 0, receipts = 0, active = 0, previousId: string | undefined;
  const recordsDigest = createHash('sha256'), receiptsDigest = createHash('sha256');
  for (let index = 0; index < ns.prefix.entries; index++) {
    const bytes = files.read(path, ref, documentEventName(index + 1), names), event = decodeDocumentSeed(bytes);
    const change = event.change;
    if (event.sequence !== index + 1 || event.previous !== previous || documentDigest(event.scope) !== documentDigest(ns.scope) ||
      change.operationId !== identity.operationId || change.snapshotDigest !== identity.snapshotDigest) invalid();
    if (index < ns.records) {
      if (change.kind !== 'seed_record' || previousId !== undefined && utf8Compare(previousId, change.next.id) >= 0) invalid();
      previousId = change.next.id; receipts = checkedImportSum([receipts, change.receipts.length]); if (change.next.status === 'active') active++;
      recordsDigest.update(documentDigest({ id: change.next.id, sourceRecordJsonDigest: change.sourceRecordJsonDigest }) + '\n');
      for (const receipt of change.receipts) receiptsDigest.update(documentDigest({ id: change.next.id, ...receipt }) + '\n');
    } else if (change.kind !== 'seed_head' || change.records !== ns.records || change.receipts !== ns.receipts || change.audits !== ns.audits ||
      change.activeRecords !== ns.activeRecords || documentDigest(change.head) !== documentDigest(ns.head)) invalid();
    previous = sha256(bytes); total += bytes.length;
    if (!files.read(witnessPath, witness, witnessName(index + 1), witnessNames, 4096).equals(witnessBytes(ns.scope, index + 1, previous))) invalid('document_knowledge_witness_invalid');
  }
  if (previous !== ns.prefix.lastDigest || total !== ns.prefix.bytes || receipts !== ns.receipts || active !== ns.activeRecords ||
    recordsDigest.digest('hex') !== ns.currentRecordsDigest || receiptsDigest.digest('hex') !== ns.receiptsDigest) invalid();
  if (!documentNamesEqual(names, files.names(path, ref)) || !documentNamesEqual(witnessNames, files.names(witnessPath, witness))) invalid('document_knowledge_contention');
  importedBarrier(() => {
    files.sync(ref); files.sync(witness); files.check(path, ref); files.check(witnessPath, witness);
  });
}
export function importDocumentKnowledgeSnapshot(directory: string, binding: DocumentKnowledgeBinding, reader: PersonalMemorySnapshotReader,
  raw: PersonalMemoryImportOptions & { expectedManifestDigest: string }): PersonalMemoryImportReceipt {
  const { expectedManifestDigest, ...options } = raw; documentHash.parse(expectedManifestDigest);
  const prepared = prepare(reader, options);
  if (prepared.receipt.manifestDigest !== expectedManifestDigest) invalid('document_knowledge_import_conflict');
  if (binding.agentId !== options.agentId || binding.storeId !== options.storeId) invalid('document_knowledge_owner_mismatch');
  const files = new DocumentFiles(directory, binding);
  try {
    const state = prepareDocumentImportRoot(files, prepared.bytes);
    if (state !== 'complete') {
      for (const ns of prepared.manifest.namespaces) {
        for (let retry = 0; ; retry++) {
          try { importNamespace(files, reader, ns, options); break; }
          catch (error) {
            if (!(error instanceof FileBoundaryFault) || !['changed', 'missing'].includes(error.code) || retry + 1 >= documentLimits.retries) throw error;
          }
        }
      }
      // Re-read every imported prefix after all writes, then publish format last. Agent activation is a separate host operation.
      for (const ns of prepared.manifest.namespaces) verifyPrefix(files, ns, prepared.manifest, false);
      const ref = files.directoryRef(files.directory)!;
      if (inspectDocumentImportRoot(files, prepared.bytes) !== 'incomplete') invalid('document_knowledge_import_conflict');
      publishExact(files, files.directory, ref, 'format.json', Buffer.from(JSON.stringify(importedStoreFormat(prepared.manifest, prepared.bytes))));
    } else for (const ns of prepared.manifest.namespaces) verifyPrefix(files, ns, prepared.manifest, true);
    if (inspectDocumentImportRoot(files, prepared.bytes) !== 'complete') invalid('document_knowledge_import_conflict');
    const root = files.directoryRef(files.directory)!; importedBarrier(() => { files.sync(root); files.check(files.directory, root); });
    return prepared.receipt;
  } finally { files.close(); }
}
export function inspectDocumentKnowledgeImport(directory: string, binding: DocumentKnowledgeBinding,
  expected: { operationId: string; manifestDigest: string }): 'missing' | 'incomplete' | 'complete' {
  z.uuid().parse(expected.operationId); documentHash.parse(expected.manifestDigest);
  const files = new DocumentFiles(directory, binding);
  try {
    const ref = files.directoryRef(files.directory); if (!ref) return 'missing';
    const names = files.names(files.directory, ref);
    if (!names.includes('import-manifest.json')) {
      return inspectUnpreparedDocumentImportRoot(files);
    }
    const bytes = files.read(files.directory, ref, 'import-manifest.json', names), manifest = decodeDocumentImportManifest(bytes);
    if (sha256(bytes) !== expected.manifestDigest || manifest.operationId !== expected.operationId) invalid('document_knowledge_import_conflict');
    const state = inspectDocumentImportRoot(files, bytes);
    if (state === 'complete') {
      for (const ns of manifest.namespaces) verifyPrefix(files, ns, manifest, true);
      importedBarrier(() => { files.sync(ref); files.check(files.directory, ref); });
    }
    return state;
  } finally { files.close(); }
}
