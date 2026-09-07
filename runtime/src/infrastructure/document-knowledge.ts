import { join } from 'node:path';
import { z } from 'zod';
import type { KnowledgeCandidates, KnowledgeCommit, KnowledgeCommitResult, KnowledgeRepository, KnowledgeStoreScope } from '../application/knowledge-ports.js';
import { parseKnowledge } from '../application/knowledge-contracts.js';
import { canReadKnowledge, type KnowledgeIndexHead, type KnowledgeQuery, type KnowledgeRecord, type TrustedKnowledgeActor } from '../domain/knowledge.js';
import { FileBoundaryFault, type MetadataDirectory } from './host-metadata-files.js';
import { FileMutationFault, type FilePublicationResult } from './host-file-mutations.js';
import { sha256 } from './digest.js';
import { DocumentFiles, assertDocumentKnowledgeStore, documentNamesEqual, documentPending, type DocumentKnowledgeBinding } from './document-knowledge-owner.js';
import { DocumentKnowledgeError, decodeDocumentEvent, documentDigest, documentEventName, documentLimits, documentName, documentNamespaceName,
  documentNamespaceSchema, documentHash, encodeDocumentEvent, indexErrors, validateDocumentRecord, validateDocumentTransition,
  type DocumentChange, type DocumentNamespace } from './document-knowledge-codec.js';
import { decodeDocumentSeed, utf8Compare, type DocumentStoreDescriptor } from './document-knowledge-import-codec.js';
export { DocumentKnowledgeError, documentLimits } from './document-knowledge-codec.js';
export { registerDocumentKnowledgeStore, inspectDocumentKnowledgeStore, type DocumentKnowledgeBinding } from './document-knowledge-owner.js';

type Receipt = { digest: string; revision: number };
type Snapshot = { records: Map<string, KnowledgeRecord>; receipts: Map<string, Receipt>; head: KnowledgeIndexHead;
  sequence: number; digest: string | null; bytes: number; ref: MetadataDirectory | null; witness: MetadataDirectory | null; signature: string };
const empty = (ref: MetadataDirectory | null): Snapshot => ({ records: new Map(), receipts: new Map(), head: { revision: 0, cursor: 0, error: null }, sequence: 0, digest: null, bytes: 0, ref, witness: null, signature: '' });
const witnessSchema = z.strictObject({ scope: documentNamespaceSchema, sequence: z.number().int().min(1).max(documentLimits.entries), digest: documentHash });
const witnessName = (sequence: number) => `${String(sequence).padStart(8, '0')}.json`;
const receiptKey = (id: string, command: string) => JSON.stringify([id, command]);
const normalizedDocument = (record: KnowledgeRecord) => `${record.title}\n${record.body}`.normalize('NFC').toLocaleLowerCase('en-US');
function recoveryFailure(stage: string, error: unknown): FileMutationFault {
  return new FileMutationFault('publish', stage, { publication: 'published', created: false, fileSynced: false,
    directorySynced: false, cleanup: 'not_needed' }, [{ stage, error }]);
}

/** Canonical immutable Markdown; record and command receipt share one no-overwrite publication. */
export class DocumentKnowledgeRepository implements KnowledgeRepository {
  readonly #files: DocumentFiles;
  readonly #descriptor: DocumentStoreDescriptor;
  readonly #synced = new Map<string, string>();
  #closed = false;
  constructor(directory: string, binding: DocumentKnowledgeBinding) {
    this.#files = new DocumentFiles(directory, binding);
    try { this.#descriptor = assertDocumentKnowledgeStore(this.#files); }
    catch (error) { this.#files.close(); throw error; }
  }
  #alive() {
    if (this.#closed) throw new DocumentKnowledgeError('document_knowledge_closed');
    if (documentDigest(assertDocumentKnowledgeStore(this.#files)) !== documentDigest(this.#descriptor)) throw new DocumentKnowledgeError('document_knowledge_format_invalid');
  }
  #scope(tenantId: string, raw?: KnowledgeStoreScope, namespace = 'personal'): DocumentNamespace {
    this.#alive();
    if (!raw) throw new DocumentKnowledgeError('knowledge_scope_required');
    if (raw.partition !== 'personal' || raw.agentId !== this.#files.binding.agentId || namespace !== 'personal' ||
      Object.keys(raw).some(key => !['agentId', 'partition', 'principalId'].includes(key))) throw new DocumentKnowledgeError('knowledge_scope_mismatch');
    return documentNamespaceSchema.parse({ tenantId, ...raw, namespace });
  }
  #path(scope: DocumentNamespace) { return join(this.#files.directory, documentNamespaceName(scope)); }
  #witnessPath(scope: DocumentNamespace) { return join(this.#files.directory, `witness-${documentDigest(scope)}`); }
  #scan(scope: DocumentNamespace): Snapshot {
    const path = this.#path(scope), ref = this.#files.directoryRef(path);
    const names = ref ? this.#files.names(path, ref) : [], normal = names.filter(name => !documentPending.test(name));
    if (normal.length > documentLimits.entries) throw new DocumentKnowledgeError('document_knowledge_limit_exceeded');
    if (normal.some(name => !/^\d{8}\.md$/.test(name))) throw new DocumentKnowledgeError('document_knowledge_record_invalid');
    const imported = this.#descriptor.schemaVersion === 2 ? this.#descriptor.manifest.namespaces.find(ns => documentDigest(ns.scope) === documentDigest(scope)) : undefined;
    if (imported && normal.length < imported.prefix.entries) throw new DocumentKnowledgeError('document_knowledge_history_missing');
    if (ref) this.#files.pending(path, ref, names);
    const result = empty(ref);
    const digests: string[] = [], tokens: string[] = [];
    let previousSeedId: string | undefined, seedReceipts = 0, activeSeeds = 0;
    for (const name of normal) {
      if (name !== documentEventName(result.sequence + 1)) throw new DocumentKnowledgeError('document_knowledge_sequence_invalid');
      const bytes = this.#files.read(path, ref!, name, names); result.bytes += bytes.length;
      if (result.bytes > documentLimits.bytes) throw new DocumentKnowledgeError('document_knowledge_limit_exceeded');
      const seeded = imported && result.sequence < imported.prefix.entries;
      const event = seeded ? decodeDocumentSeed(bytes) : decodeDocumentEvent(bytes);
      if (event.schemaVersion !== this.#descriptor.schemaVersion) throw new DocumentKnowledgeError('document_knowledge_record_invalid');
      if (event.sequence !== result.sequence + 1 || event.previous !== result.digest || documentDigest(event.scope) !== documentDigest(scope)) throw new DocumentKnowledgeError('document_knowledge_sequence_invalid');
      const change = event.change;
      if (change.kind === 'seed_record' || change.kind === 'seed_head') {
        if (!imported || this.#descriptor.schemaVersion !== 2 || change.operationId !== this.#descriptor.manifest.operationId ||
          change.snapshotDigest !== this.#descriptor.manifest.snapshotDigest) throw new DocumentKnowledgeError('document_knowledge_import_invalid');
        if (change.kind === 'seed_record') {
          if (result.sequence >= imported.records || previousSeedId !== undefined && utf8Compare(previousSeedId, change.next.id) >= 0) throw new DocumentKnowledgeError('document_knowledge_import_invalid');
          previousSeedId = change.next.id; result.records.set(change.next.id, change.next);
          for (const receipt of change.receipts) {
            const key = receiptKey(change.next.id, receipt.commandId);
            if (result.receipts.has(key)) throw new DocumentKnowledgeError('document_knowledge_import_invalid');
            result.receipts.set(key, { digest: receipt.digest, revision: receipt.revision });
          }
          seedReceipts += change.receipts.length; if (change.next.status === 'active') activeSeeds++;
        } else {
          if (result.sequence !== imported.records || change.records !== result.records.size || change.receipts !== seedReceipts || change.audits !== seedReceipts ||
            change.activeRecords !== activeSeeds || change.records !== imported.records || change.receipts !== imported.receipts || change.audits !== imported.audits ||
            change.activeRecords !== imported.activeRecords || documentDigest(change.head) !== documentDigest(imported.head)) throw new DocumentKnowledgeError('document_knowledge_import_invalid');
          result.head = { ...change.head };
        }
      } else if (change.kind === 'record') {
        const next = change.next, old = result.records.get(next.id), key = receiptKey(next.id, change.commandId);
        if (result.receipts.has(key) || (old?.revision ?? 0) !== change.expectedRevision) throw new DocumentKnowledgeError('document_knowledge_sequence_invalid');
        validateDocumentTransition(old, next, change.expectedRevision);
        result.records.set(next.id, next); result.receipts.set(key, { digest: change.commandDigest, revision: next.revision });
        if (result.head.cursor === result.head.revision && result.head.error === null) result.head.cursor++;
        result.head.revision++;
      } else if (change.action === 'rebuild') { result.head.cursor = result.head.revision; result.head.error = null; }
      else result.head.error = change.code;
      result.sequence++; result.digest = sha256(bytes);
      if (imported && result.sequence === imported.prefix.entries &&
        (result.digest !== imported.prefix.lastDigest || result.bytes !== imported.prefix.bytes)) throw new DocumentKnowledgeError('document_knowledge_import_invalid');
      digests.push(result.digest); tokens.push(this.#files.token(join(path, name)));
    }
    if (ref && !documentNamesEqual(names, this.#files.names(path, ref))) throw new DocumentKnowledgeError('document_knowledge_contention');
    const witnessPath = this.#witnessPath(scope); let witness = this.#files.directoryRef(witnessPath);
    const witnessNames = witness ? this.#files.names(witnessPath, witness) : [], recorded = witnessNames.filter(name => !documentPending.test(name));
    if (recorded.length > documentLimits.entries) throw new DocumentKnowledgeError('document_knowledge_limit_exceeded');
    if (witness) this.#files.pending(witnessPath, witness, witnessNames);
    for (const [index, name] of recorded.entries()) {
      if (name !== witnessName(index + 1) || index >= digests.length) throw new DocumentKnowledgeError('document_knowledge_history_missing');
      let value: z.infer<typeof witnessSchema>;
      try { value = witnessSchema.parse(JSON.parse(this.#files.read(witnessPath, witness!, name, witnessNames, 4096).toString('utf8'))); }
      catch (cause) { throw new DocumentKnowledgeError('document_knowledge_witness_invalid', { cause }); }
      if (value.sequence !== index + 1 || value.digest !== digests[index] || documentDigest(value.scope) !== documentDigest(scope)) throw new DocumentKnowledgeError('document_knowledge_witness_invalid');
    }
    if (witness && !documentNamesEqual(witnessNames, this.#files.names(witnessPath, witness))) throw new DocumentKnowledgeError('document_knowledge_contention');
    // A complete event is the commit point. Repair only its missing witness suffix, never missing canonical data.
    if (recorded.length < digests.length) {
      try {
        witness ??= this.#files.directoryRef(witnessPath, true)!;
        for (let index = recorded.length; index < digests.length; index++) {
          const name = witnessName(index + 1), bytes = Buffer.from(JSON.stringify({ scope, sequence: index + 1, digest: digests[index]! }));
          this.#files.scope.publish(witness, name, bytes);
          const actual = this.#files.read(witnessPath, witness, name, this.#files.names(witnessPath, witness), 4096);
          if (!actual.equals(bytes)) throw new DocumentKnowledgeError('document_knowledge_witness_invalid');
        }
      } catch (error) { throw recoveryFailure('knowledge_witness_recovery', error); }
    }
    if (witness) {
      const final = this.#files.names(witnessPath, witness);
      const finalRecorded = final.filter(name => !documentPending.test(name));
      if (finalRecorded.length !== digests.length) throw new DocumentKnowledgeError('document_knowledge_contention');
      for (const name of finalRecorded) tokens.push(this.#files.token(join(witnessPath, name)));
      this.#files.check(witnessPath, witness);
    }
    if (ref) this.#files.check(path, ref);
    result.witness = witness;
    result.signature = documentDigest({ sequence: result.sequence, digest: result.digest, directory: ref?.identity ?? null, witness: witness?.identity ?? null, tokens });
    return result;
  }
  #snapshot(scope: DocumentNamespace): Snapshot {
    let prior: Snapshot | undefined;
    for (let retry = 0; retry < documentLimits.retries; retry++) {
      this.#alive(); let current: Snapshot;
      try { current = this.#scan(scope); }
      catch (error) {
        if (retry + 1 < documentLimits.retries && (error instanceof DocumentKnowledgeError &&
          ['document_knowledge_contention', 'document_knowledge_history_missing'].includes(error.code) ||
          error instanceof FileBoundaryFault && ['changed', 'missing'].includes(error.code))) { prior = undefined; continue; }
        throw error;
      }
      this.#alive();
      if (prior && prior.signature === current.signature) { this.#sync(scope, current); return current; }
      prior = current;
    }
    throw new DocumentKnowledgeError('document_knowledge_contention');
  }
  #sync(scope: DocumentNamespace, snapshot: Snapshot) {
    if (!snapshot.ref && !snapshot.witness) { this.#alive(); return; }
    const key = documentNamespaceName(scope);
    if (this.#synced.get(key) !== snapshot.signature) {
      try {
        if (snapshot.ref) { this.#files.sync(snapshot.ref); this.#files.check(this.#path(scope), snapshot.ref); }
        if (snapshot.witness) { this.#files.sync(snapshot.witness); this.#files.check(this.#witnessPath(scope), snapshot.witness); }
      } catch (error) { if (snapshot.sequence) throw recoveryFailure('knowledge_barrier', error); throw error; }
      this.#synced.set(key, snapshot.signature);
    }
    this.#alive();
  }
  #publish(scope: DocumentNamespace, snapshot: Snapshot, change: DocumentChange): FilePublicationResult {
    const bytes = encodeDocumentEvent({ schemaVersion: this.#descriptor.schemaVersion, scope, sequence: snapshot.sequence + 1, previous: snapshot.digest, change });
    if (snapshot.sequence >= documentLimits.entries || snapshot.bytes + bytes.length > documentLimits.bytes) throw new DocumentKnowledgeError('document_knowledge_limit_exceeded');
    const ref = snapshot.ref ?? this.#files.directoryRef(this.#path(scope), true)!;
    // Do not wrap FileMutationFault: publication/flush/cleanup and original causes must reach the caller.
    const result = this.#files.scope.publish(ref, documentEventName(snapshot.sequence + 1), bytes);
    try { this.#alive(); } catch (error) { throw new FileMutationFault('publish', 'knowledge_recheck', result, [{ stage: 'knowledge_recheck', error }]); }
    return result;
  }
  async get(tenantId: string, id: string, selector?: KnowledgeStoreScope): Promise<KnowledgeRecord | null> {
    const scope = this.#scope(tenantId, selector); documentName.parse(id);
    return structuredClone(this.#snapshot(scope).records.get(id) ?? null);
  }
  async receipt(tenantId: string, id: string, commandId: string, selector?: KnowledgeStoreScope): Promise<Receipt | null> {
    const scope = this.#scope(tenantId, selector); documentName.parse(id); documentName.parse(commandId);
    return structuredClone(this.#snapshot(scope).receipts.get(receiptKey(id, commandId)) ?? null);
  }
  async commit(command: KnowledgeCommit): Promise<KnowledgeCommitResult> {
    const next = parseKnowledge(command.next), scope = this.#scope(next.tenantId, command.scope);
    documentName.parse(command.commandId); validateDocumentRecord(next, scope); validateDocumentTransition(undefined, next, command.expectedRevision);
    for (let retry = 0; retry < documentLimits.retries; retry++) {
      const snapshot = this.#snapshot(scope), receipt = snapshot.receipts.get(receiptKey(next.id, command.commandId));
      if (receipt) {
        if (receipt.digest !== command.commandDigest) return { kind: 'idempotency_conflict' };
        this.#sync(scope, snapshot); return { kind: 'duplicate', revision: receipt.revision };
      }
      const old = snapshot.records.get(next.id), actualRevision = old?.revision ?? 0;
      if (actualRevision !== command.expectedRevision) return { kind: 'conflict', actualRevision };
      validateDocumentTransition(old, next, command.expectedRevision);
      const publication = this.#publish(scope, snapshot, { kind: 'record', expectedRevision: command.expectedRevision, commandId: command.commandId, commandDigest: command.commandDigest, next });
      if (publication.published) {
        try {
          const stored = this.#snapshot(scope).receipts.get(receiptKey(next.id, command.commandId));
          if (!stored || stored.digest !== command.commandDigest || stored.revision !== next.revision) throw new DocumentKnowledgeError('document_knowledge_publication_changed');
        } catch (error) { throw new FileMutationFault('publish', 'knowledge_witness', publication, [{ stage: 'knowledge_witness', error }]); }
        return { kind: 'committed', revision: next.revision };
      }
    }
    throw new DocumentKnowledgeError('document_knowledge_contention');
  }
  async indexHead(tenantId: string, namespace: string, selector?: KnowledgeStoreScope): Promise<KnowledgeIndexHead> {
    return { ...this.#snapshot(this.#scope(tenantId, selector, namespace)).head };
  }
  async candidates(actor: TrustedKnowledgeActor, query: KnowledgeQuery, maximum: number, selector?: KnowledgeStoreScope): Promise<KnowledgeCandidates> {
    const scope = this.#scope(actor.tenantId, selector, query.namespace);
    if (actor.agentId !== scope.agentId || actor.principalId !== scope.principalId || query.scope !== 'personal' || query.kinds.length !== 1 || query.kinds[0] !== 'personal') throw new DocumentKnowledgeError('knowledge_scope_mismatch');
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 200 || !actor.allowedNamespaces.includes(query.namespace) || typeof query.text !== 'string') throw new DocumentKnowledgeError('invalid_knowledge_index_request');
    // Expiry uses the service's injected clock, as in the SQLite candidate path. The repository checks access and status.
    const ids = [...this.#snapshot(scope).records.values()].filter(record => canReadKnowledge(record, actor, -Infinity) && normalizedDocument(record).includes(query.text))
      .map(record => record.id).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return { ids: ids.slice(0, maximum), truncated: ids.length > maximum };
  }
  async #index(tenantId: string, namespace: string, selector: KnowledgeStoreScope | undefined, change: Extract<DocumentChange, { kind: 'index' }>): Promise<KnowledgeIndexHead> {
    const scope = this.#scope(tenantId, selector, namespace);
    for (let retry = 0; retry < documentLimits.retries; retry++) {
      const snapshot = this.#snapshot(scope);
      if (change.action === 'rebuild' ? snapshot.head.cursor === snapshot.head.revision && snapshot.head.error === null : snapshot.head.error === change.code) {
        this.#sync(scope, snapshot); return { ...snapshot.head };
      }
      const publication = this.#publish(scope, snapshot, change);
      if (publication.published) {
        try { return { ...this.#snapshot(scope).head }; }
        catch (error) { throw new FileMutationFault('publish', 'knowledge_witness', publication, [{ stage: 'knowledge_witness', error }]); }
      }
    }
    throw new DocumentKnowledgeError('document_knowledge_contention');
  }
  async rebuildIndex(tenantId: string, namespace: string, selector?: KnowledgeStoreScope): Promise<KnowledgeIndexHead> {
    return this.#index(tenantId, namespace, selector, { kind: 'index', action: 'rebuild' });
  }
  async markIndexError(tenantId: string, namespace: string, code: string, selector?: KnowledgeStoreScope): Promise<void> {
    if (!(indexErrors as readonly string[]).includes(code)) throw new DocumentKnowledgeError('invalid_knowledge_index_error');
    await this.#index(tenantId, namespace, selector, { kind: 'index', action: 'error', code: code as typeof indexErrors[number] });
  }
  async close(): Promise<void> { if (!this.#closed) { this.#closed = true; this.#files.close(); } }
}
