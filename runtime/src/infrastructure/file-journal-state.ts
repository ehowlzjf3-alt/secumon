import { closeSync, constants, existsSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CommitRequest, CommitResult, ConversationWorkQuery, RecentEventMetadataQuery, StateRepository } from '../application/ports.js';
import { parseContract } from '../application/contracts.js';
import { validateCommit, validateStateTransition } from '../application/store-contract.js';
import { matchesConversation, selectRecentEventMetadata, validateConversationQuery, validateRecentEventQuery } from '../application/state-query.js';
import type { Delivery, StoredEvent, WorkState } from '../domain/model.js';
import { sha256 } from './digest.js';
import { decodeStateQueryCursor, encodeStateQueryCursor } from './state-query-cursor.js';
import { isJournalRecordPath, storageRootParts } from './local-file-paths.js';
import { copyJournalOwner, inspectJournalInitialization, JournalStateError, parseJournalHeader, readJournalMetadata, type JournalHeader, type JournalOwner } from './journal-ownership.js';
import { FileBoundaryFault, hostMetadataFiles, completeMetadataPublication, hostFileDurabilityPolicy, type HostMetadataFiles, type MetadataDirectory } from './host-metadata-files.js';
import { FileMutationFault } from './host-file-mutations.js';
import { WindowsMetadataFiles } from './windows-metadata-files.js';
import { WindowsJournalFiles } from './windows-journal-files.js';
import { windowsStreamLimits } from './windows-stream-files.js';
export { inspectJournalOwnership, JournalStateError, type JournalOwner } from './journal-ownership.js';

export type JournalStage = 'candidate_synced' | 'published' | 'directory_synced';
export interface JournalOptions {
  owner?: JournalOwner;
  maxRecordBytes?: number;
  /** Serialized retained projection accounting, not a process heap limit. Zero disables reuse. */
  maxCacheBytes?: number;
  onCommitStage?: (stage: JournalStage, identity: { workId: string; revision: number }) => void | Promise<void>;
}
type Projection = { state: WorkState | null; events: StoredEvent[]; deliveries: Map<string, Delivery>; receipts: Map<string, { digest: string; state: WorkState }>; hash: string | null };
type RecordDigest = { digest: string; checksum: string; identity: RecordIdentity };
type CachedProjection = { projection: Projection; records: RecordDigest[]; bytes: number };
type RecordIdentity = { dev: string; ino: string };
const recordSchema = z.strictObject({ schemaVersion: z.literal(1), storeId: z.uuid(), previousHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), request: z.unknown(), checksum: z.string().regex(/^[a-f0-9]{64}$/) });
const recordName = (revision: number) => `${String(revision).padStart(16, '0')}.json`;
const validRecordName = (name: string) => /^\d{16}\.json$/.test(name) && Number.isSafeInteger(Number(name.slice(0, 16))) && Number(name.slice(0, 16)) >= 1;
const nativePendingName = /^\.secumon-init-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pending$/;
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

export class FileJournalStateRepository implements StateRepository {
  #root: string;
  readonly #files: HostMetadataFiles;
  readonly #windows: WindowsJournalFiles | undefined;
  readonly #parentDirectory: MetadataDirectory;
  #rootDirectory: MetadataDirectory;
  #workDirectories = new Map<string, MetadataDirectory>();
  #knownWorkIds = new Map<string, string>();
  #observedHeads = new Map<string, { revision: number; hash: string }>();
  #cache = new Map<string, CachedProjection>();
  #cacheBytes = 0;
  #metrics = { headerReads: 0, headerBytes: 0, recordReads: 0, recordBytes: 0, rawHashCalls: 0, rawHashBytes: 0,
    checksumHashCalls: 0, checksumHashBytes: 0, parsedRecords: 0, replayedRecords: 0, discoveryParses: 0,
    cacheHits: 0, cacheEvictions: 0, metadataChecks: 0, directorySyncs: 0, inspectedWorks: 0 };
  #header: JournalHeader;
  readonly #owner: Readonly<JournalOwner> | undefined;
  #closed = false;
  readonly options: Readonly<JournalOptions>;
  readonly maxRecordBytes: number;
  readonly maxCacheBytes: number;
  constructor(directory: string, options: JournalOptions = {}) {
    try { this.#files = hostMetadataFiles(); }
    catch (error) {
      if (error instanceof FileBoundaryFault && error.code === 'unsupported_platform') throw new JournalStateError('journal_platform_unsupported', error);
      throw error;
    }
    this.#owner = options.owner === undefined ? undefined : copyJournalOwner(options.owner);
    this.options = Object.freeze({ ...options, ...(this.#owner ? { owner: this.#owner } : {}) }); this.maxRecordBytes = options.maxRecordBytes ?? 67108864;
    this.maxCacheBytes = options.maxCacheBytes ?? 33554432;
    if (!Number.isSafeInteger(this.maxRecordBytes) || this.maxRecordBytes < 1 || !Number.isSafeInteger(this.maxCacheBytes) || this.maxCacheBytes < 0) throw new JournalStateError('invalid_journal_configuration');
    if (this.#files instanceof WindowsMetadataFiles && this.maxRecordBytes > windowsStreamLimits.fileBytes) throw new JournalStateError('invalid_journal_configuration');
    const parts = storageRootParts(directory);
    if (!parts) throw new JournalStateError('journal_root_invalid');
    if (this.#files instanceof WindowsMetadataFiles) {
      this.#windows = new WindowsJournalFiles(this.#files, join(parts.parent, parts.name));
      this.#root = this.#windows.root; this.#parentDirectory = this.#windows.parent; this.#rootDirectory = this.#windows.directory;
    } else {
      this.#windows = undefined;
      if (!existsSync(parts.parent)) throw new JournalStateError('journal_parent_missing');
      const parent = realpathSync(parts.parent);
      this.#parentDirectory = this.#directory(parent, undefined, 'sync');
      this.#root = join(parent, parts.name);
      try { mkdirSync(this.#root, { mode: 0o700 }); } catch (error) { if (code(error) !== 'EEXIST') throw error; }
      this.#rootDirectory = this.#directory(this.#root);
    }
    try {
      this.#header = this.#initialize();
      this.#sync(this.#rootDirectory); this.#sync(this.#parentDirectory);
    } catch (error) {
      try { this.#windows?.close(); } catch (close) { throw new AggregateError([error, close], 'journal_initialization_cleanup_failed', { cause: error }); }
      throw error;
    }
  }
  #directory(path: string, expected?: MetadataDirectory, access: 'private' | 'sync' = 'private'): MetadataDirectory {
    this.#metrics.metadataChecks++;
    try {
      const directory = this.#windows ? this.#windows.child(path, expected) : this.#files.inspectDirectory(path, access, expected);
      if (!directory) throw new JournalStateError('journal_directory_unavailable',
        Object.assign(new Error('directory does not exist'), { code: 'ENOENT', syscall: 'lstat', path }));
      return directory;
    } catch (error) {
      if (!(error instanceof FileBoundaryFault)) throw error;
      if (error.code === 'unsafe') throw new JournalStateError('journal_directory_unsafe', error);
      if (error.code === 'changed') throw new JournalStateError('journal_directory_changed', error);
      if (error.code === 'unsupported_platform') throw new JournalStateError('journal_platform_unsupported', error);
      if (error.code === 'io' || error.code === 'missing') throw new JournalStateError('journal_directory_unavailable', error.cause ?? error);
      throw error;
    }
  }
  #sync(directory: MetadataDirectory) {
    try { completeMetadataPublication(this.#files, directory, { beforeSync: () => { this.#metrics.directorySyncs++; } }); }
    catch (error) {
      if (!(error instanceof FileBoundaryFault)) throw error;
      if (error.code === 'unsafe') throw new JournalStateError('journal_directory_unsafe', error);
      if (error.code === 'changed') throw new JournalStateError('journal_directory_changed', error);
      if (error.code === 'unsupported_platform') throw new JournalStateError('journal_platform_unsupported', error);
      if ((error.code === 'io' || error.code === 'missing') && error.cause !== undefined) throw error.cause;
      throw error;
    }
  }
  #readFile(path: string, maxBytes = this.maxRecordBytes, expected?: RecordIdentity, observed?: (identity: RecordIdentity) => void, mayRetry = true): Buffer {
    if (this.#windows) {
      try { return this.#windows.read(path, maxBytes, expected, observed, {
        metadata: () => { this.#metrics.metadataChecks++; },
        read: bytes => { if (isJournalRecordPath(path)) { this.#metrics.recordReads++; this.#metrics.recordBytes += bytes; }
          else { this.#metrics.headerReads++; this.#metrics.headerBytes += bytes; } },
      }); }
      catch (error) {
        if (!(error instanceof FileBoundaryFault)) throw error;
        if (error.code === 'changed') throw new JournalStateError('journal_record_changed', error);
        if (error.code === 'too_large') throw new JournalStateError('journal_record_too_large', error);
        if (error.code === 'unsafe' || error.code === 'invalid_request') throw new JournalStateError('journal_file_unsafe', error);
        throw error;
      }
    }
    if (!isJournalRecordPath(path)) return readJournalMetadata(path, maxBytes, {
      metadata: () => { this.#metrics.metadataChecks++; },
      read: bytes => { this.#metrics.headerReads++; this.#metrics.headerBytes += bytes; },
    });
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      this.#metrics.metadataChecks++; const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile() || (stat.mode & 0o077n) !== 0n || (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()))) throw new JournalStateError('journal_file_unsafe');
      if (stat.size > BigInt(maxBytes)) throw new JournalStateError('journal_record_too_large');
      const record = isJournalRecordPath(path);
      if (expected && (expected.dev !== stat.dev.toString() || expected.ino !== stat.ino.toString())) throw new JournalStateError('journal_record_changed');
      const bytes = readFileSync(fd);
      if (record) { this.#metrics.recordReads++; this.#metrics.recordBytes += bytes.length; }
      else { this.#metrics.headerReads++; this.#metrics.headerBytes += bytes.length; }
      this.#metrics.metadataChecks += 2;
      const after = fstatSync(fd, { bigint: true }); const named = lstatSync(path, { bigint: true });
      if (BigInt(bytes.length) !== stat.size || bytes.length > maxBytes || named.isSymbolicLink() || named.dev !== after.dev || named.ino !== after.ino ||
        ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].some(key => stat[key as keyof typeof stat] !== after[key as keyof typeof after]) ||
        ['mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].some(key => after[key as keyof typeof after] !== named[key as keyof typeof named])) {
        if (mayRetry) return this.#readFile(path, maxBytes, expected, observed, false);
        throw new JournalStateError('journal_record_changed');
      }
      observed?.({ dev: stat.dev.toString(), ino: stat.ino.toString() });
      return bytes;
    } finally { closeSync(fd); }
  }
  #candidate(folder: string, bytes: Uint8Array): string {
    const file = join(folder, `${randomUUID()}.pending`);
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); }
    catch (error) { try { unlinkSync(file); } catch {} throw error; }
    finally { closeSync(fd); }
    return file;
  }
  #initialize(): JournalHeader {
    const file = join(this.#root, 'format.json');
    const readHeader = () => parseJournalHeader(this.#readFile(file, 4096), this.#owner);
    try { return readHeader(); }
    catch (error) {
      if (code(error) !== 'ENOENT') { if (error instanceof JournalStateError) throw error; throw new JournalStateError('journal_format_invalid', error); }
    }
    if (inspectJournalInitialization(this.#root, this.#owner) === 'owned') return readHeader();
    const value: JournalHeader = this.#owner ? { kind: 'long-horizon-file-journal', schemaVersion: 2, storeId: randomUUID(), owner: this.#owner } :
      { kind: 'long-horizon-file-journal', schemaVersion: 1, storeId: randomUUID() };
    if (this.#windows) {
      try { this.#windows.publishHeader(Buffer.from(JSON.stringify(value))); return readHeader(); }
      catch (error) {
        if (error instanceof FileMutationFault && error.status.publication !== 'not_published') throw new JournalStateError('journal_initialization_unknown', error);
        throw error;
      }
    }
    const candidate = this.#candidate(this.#root, Buffer.from(JSON.stringify(value)));
    try { try { linkSync(candidate, file); } catch (error) { if (code(error) !== 'EEXIST') throw error; } }
    finally { try { unlinkSync(candidate); } catch {} }
    return readHeader();
  }
  #check() {
    if (this.#closed) throw new JournalStateError('store_closed');
    this.#directory(this.#root, this.#rootDirectory);
    const header = parseJournalHeader(this.#readFile(join(this.#root, 'format.json'), 4096), this.#owner);
    if (JSON.stringify(header) !== JSON.stringify(this.#header)) throw new JournalStateError('journal_store_changed');
  }
  #key(workId: string) {
    if (typeof workId !== 'string' || !workId.length || workId.length > 256) throw new JournalStateError('invalid_work_id');
    return sha256(workId);
  }
  #workDirectory(workId: string, create: boolean): string | null {
    this.#check(); const key = this.#key(workId); const folder = join(this.#root, key);
    if (this.#windows) {
      const known = this.#workDirectories.get(key), directory = this.#windows.child(folder, known, create);
      if (!directory) { if (!known && !create) return null; throw new JournalStateError('journal_directory_unavailable'); }
      this.#workDirectories.set(key, directory); return folder;
    }
    if (create && !this.#workDirectories.has(key)) { try { mkdirSync(folder, { mode: 0o700 }); } catch (error) { if (code(error) !== 'EEXIST') throw error; } }
    try { lstatSync(folder); }
    catch (error) {
      if (code(error) === 'ENOENT' && !create && !this.#workDirectories.has(key)) return null;
      throw new JournalStateError('journal_directory_unavailable', error);
    }
    this.#workDirectories.set(key, this.#directory(folder, this.#workDirectories.get(key)));
    return folder;
  }
  #fence(folder?: string) {
    this.#check();
    if (folder) {
      const directory = this.#workDirectories.get(folder.slice(this.#root.length + 1));
      if (!directory) throw new FileBoundaryFault('invalid_request', 'directory');
      this.#directory(folder, directory); this.#sync(directory);
    }
    this.#sync(this.#rootDirectory); this.#sync(this.#parentDirectory); this.#check();
  }
  #replay(workId: string): Projection {
    const cached = this.#cache.get(workId);
    let projection: Projection = cached?.projection ?? { state: null, events: [], deliveries: new Map(), receipts: new Map(), hash: null };
    const records = cached ? [...cached.records] : []; let changed = !cached;
    const observed = this.#observedHeads.get(workId);
    const folder = this.#workDirectory(workId, false);
    if (!folder) { this.#fence(); return projection; }
    for (let revision = 1; ; revision++) {
      let bytes: Buffer; let identity!: RecordIdentity; const known = cached?.records[revision - 1];
      const read = () => this.#readFile(join(folder, recordName(revision)), this.maxRecordBytes, known?.identity, current => { identity = current; });
      try { bytes = read(); }
      catch (error) {
        if (code(error) !== 'ENOENT') throw new JournalStateError('journal_record_unavailable', error);
        const names = this.#names(folder);
        if (names.some(name => !validRecordName(name) && !this.#pending(name))) throw new JournalStateError('journal_layout_invalid');
        const later = names.some(name => /^\d{16}\.json$/.test(name) && Number(name.slice(0, 16)) >= revision);
        if (!later) { if (observed && revision <= observed.revision) throw new JournalStateError('journal_history_gap'); break; }
        try { bytes = read(); }
        catch (readError) { throw new JournalStateError('journal_history_gap', readError); }
      }
      this.#metrics.rawHashCalls++; this.#metrics.rawHashBytes += bytes.length;
      const digest = sha256(bytes);
      if (known) {
        if (known.digest !== digest) throw new JournalStateError('journal_record_invalid');
        this.#metrics.cacheHits++; continue;
      }
      if (!changed) {
        projection = { ...projection, events: [...projection.events], receipts: new Map(projection.receipts), deliveries: new Map(projection.deliveries) };
        changed = true;
      }
      let record: z.infer<typeof recordSchema>; let request: CommitRequest;
      try {
        this.#metrics.parsedRecords++;
        record = parseContract(recordSchema, JSON.parse(bytes.toString('utf8')));
        const { checksum, ...payload } = record;
        const serialized = JSON.stringify(payload); this.#metrics.checksumHashCalls++; this.#metrics.checksumHashBytes += Buffer.byteLength(serialized);
        if (sha256(serialized) !== checksum || record.storeId !== this.#header.storeId || record.previousHash !== projection.hash ||
          (observed?.revision === revision && observed.hash !== checksum)) throw new Error('chain');
        request = validateCommit(record.request as CommitRequest);
        if (request.workId !== workId || request.next.revision !== revision || request.expectedRevision !== revision - 1 || projection.receipts.has(request.commandId)) throw new Error('identity');
        validateStateTransition(projection.state, request.next);
      } catch (error) { throw new JournalStateError('journal_record_invalid', error); }
      this.#metrics.replayedRecords++;
      projection.state = request.next;
      projection.receipts.set(request.commandId, { digest: request.commandDigest, state: request.next });
      for (const event of request.events) projection.events.push({ ...event, workId, revision, commandId: request.commandId, sequence: projection.events.length + 1 });
      for (const delivery of request.deliveries) projection.deliveries.set(delivery.id, delivery);
      projection.hash = record.checksum;
      records.push({ digest, checksum: record.checksum, identity });
    }
    this.#fence(folder);
    if (projection.state && projection.hash) {
      this.#knownWorkIds.set(this.#key(workId), workId);
      this.#observeHead(workId, projection.state.revision, projection.hash);
      if (changed) this.#retain(workId, projection, records);
      else if (cached) { this.#cache.delete(workId); this.#cache.set(workId, cached); }
    }
    return projection;
  }
  #observeHead(workId: string, revision: number, hash: string) {
    const prior = this.#observedHeads.get(workId);
    if (prior?.revision === revision && prior.hash !== hash) throw new JournalStateError('journal_record_invalid');
    if (!prior || prior.revision < revision) this.#observedHeads.set(workId, { revision, hash });
  }
  #retain(workId: string, projection: Projection, records: RecordDigest[]) {
    const prior = this.#cache.get(workId);
    if (prior) { this.#cache.delete(workId); this.#cacheBytes -= prior.bytes; }
    if (this.maxCacheBytes === 0) return;
    const bytes = Buffer.byteLength(JSON.stringify({ ...projection, receipts: [...projection.receipts], deliveries: [...projection.deliveries], records }));
    if (bytes > this.maxCacheBytes) return;
    while (this.#cacheBytes + bytes > this.maxCacheBytes) {
      const oldest = this.#cache.keys().next().value!; this.#cacheBytes -= this.#cache.get(oldest)!.bytes; this.#cache.delete(oldest); this.#metrics.cacheEvictions++;
    }
    this.#cache.set(workId, { projection, records, bytes }); this.#cacheBytes += bytes;
  }
  /** Completed Node file reads and application work, not kernel disk traffic. Historical bytes are still read and hashed on every warm replay. */
  metrics() { return { ...this.#metrics, retainedProjectionBytes: this.#cacheBytes, cachedWorks: this.#cache.size,
    observedRecordIdentities: [...this.#cache.values()].reduce((sum, item) => sum + item.records.length, 0), observedWorks: this.#observedHeads.size, observedDirectories: this.#workDirectories.size }; }
  /** Windows flushes record contents but does not claim a durable directory namespace barrier. */
  durability() { return { policy: hostFileDurabilityPolicy(), namespaceBarrier: this.#windows ? 'unsupported' as const : 'fsync' as const }; }
  #existing(input: CommitRequest, projection: Projection): CommitResult | null {
    const receipt = projection.receipts.get(input.commandId);
    if (receipt) return receipt.digest === input.commandDigest ? { kind: 'duplicate', state: structuredClone(receipt.state) } : { kind: 'idempotency_conflict' };
    const actualRevision = projection.state?.revision ?? 0;
    return actualRevision === input.expectedRevision ? null : { kind: 'conflict', actualRevision };
  }
  async commit(request: CommitRequest): Promise<CommitResult> {
    this.#check(); const input = validateCommit(request); const projection = this.#replay(input.workId);
    const existing = this.#existing(input, projection); if (existing) return existing;
    validateStateTransition(projection.state, input.next);
    const folder = this.#workDirectory(input.workId, true)!;
    const payload = { schemaVersion: 1, storeId: this.#header.storeId, previousHash: projection.hash, request: input };
    const bytes = Buffer.from(JSON.stringify({ ...payload, checksum: sha256(JSON.stringify(payload)) }));
    if (bytes.length > this.maxRecordBytes) throw new JournalStateError('journal_record_too_large');
    if (this.#windows) {
      const identity = { workId: input.workId, revision: input.next.revision }; let published = false;
      try {
        const result = await this.#windows.publish(join(folder, recordName(input.next.revision)), bytes, async () => {
          await this.options.onCommitStage?.('candidate_synced', identity); this.#check(); this.#directory(folder, this.#workDirectories.get(this.#key(input.workId)));
        });
        published = result.published;
        if (!published) {
          const existing = this.#existing(input, this.#replay(input.workId));
          if (!existing) throw new JournalStateError('journal_publication_conflict'); return existing;
        }
        await this.options.onCommitStage?.('published', identity);
        this.#fence(folder);
        // The POSIX directory_synced observation is intentionally absent on Windows.
        this.#knownWorkIds.set(this.#key(input.workId), input.workId);
        this.#observeHead(input.workId, input.next.revision, sha256(JSON.stringify(payload)));
        return { kind: 'committed', state: structuredClone(input.next) };
      } catch (error) {
        if (published || error instanceof FileMutationFault && error.status.publication !== 'not_published') throw new JournalStateError('journal_commit_unknown', error);
        throw error;
      }
    }
    const candidate = this.#candidate(folder, bytes); const identity = { workId: input.workId, revision: input.next.revision }; let published = false;
    try {
      await this.options.onCommitStage?.('candidate_synced', identity); this.#check(); this.#directory(folder, this.#workDirectories.get(this.#key(input.workId)));
      try { linkSync(candidate, join(folder, recordName(input.next.revision))); published = true; }
      catch (error) {
        if (code(error) !== 'EEXIST') throw error;
        const result = this.#existing(input, this.#replay(input.workId));
        if (!result) throw new JournalStateError('journal_publication_conflict'); return result;
      }
      await this.options.onCommitStage?.('published', identity);
      this.#fence(folder);
      await this.options.onCommitStage?.('directory_synced', identity);
      this.#knownWorkIds.set(this.#key(input.workId), input.workId);
      this.#observeHead(input.workId, input.next.revision, sha256(JSON.stringify(payload)));
      return { kind: 'committed', state: structuredClone(input.next) };
    } catch (error) { if (published) throw new JournalStateError('journal_commit_unknown', error); throw error; }
    finally { try { unlinkSync(candidate); } catch {} }
  }
  async get(workId: string) { return structuredClone(this.#replay(workId).state); }
  async receipt(workId: string, commandId: string) { return structuredClone(this.#replay(workId).receipts.get(commandId) ?? null); }
  async events(workId: string, afterSequence: number) { return structuredClone(this.#replay(workId).events.filter(e => e.sequence > afterSequence)); }
  async recentEventMetadata(workId: string, input: RecentEventMetadataQuery) {
    const query = validateRecentEventQuery(workId, input); return selectRecentEventMetadata(this.#replay(workId).events, query);
  }
  async deliveries(workId: string) { return structuredClone([...this.#replay(workId).deliveries.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); }
  #names(path: string) { return this.#windows ? this.#windows.names(path) : readdirSync(path); }
  #pending(name: string) { return /^[a-f0-9-]{36}\.pending$/.test(name) || this.#windows !== undefined && nativePendingName.test(name); }
  #directories(): string[] {
    this.#check(); const names: string[] = [];
    for (const name of this.#names(this.#root).sort()) {
      if (name === 'format.json' || this.#pending(name)) continue;
      if (!/^[a-f0-9]{64}$/.test(name)) throw new JournalStateError('journal_layout_invalid');
      const folder = join(this.#root, name); this.#workDirectories.set(name, this.#directory(folder, this.#workDirectories.get(name)));
      names.push(name);
    }
    const present = new Set(names);
    for (const known of this.#workDirectories.keys()) if (!present.has(known)) throw new JournalStateError('journal_directory_unavailable');
    return names;
  }
  #readWork(name: string): WorkState | null {
      this.#metrics.inspectedWorks++;
      const known = this.#knownWorkIds.get(name); if (known !== undefined) return this.#replay(known).state;
      const folder = join(this.#root, name);
      let bytes;
      try { bytes = this.#readFile(join(folder, recordName(1))); }
      catch (error) {
        if (code(error) !== 'ENOENT') throw error;
        const names = this.#names(folder);
        if (names.some(name => !validRecordName(name) && !this.#pending(name))) throw new JournalStateError('journal_layout_invalid');
        if (!names.some(validRecordName)) { this.#directory(folder, this.#workDirectories.get(name)); return null; }
        try { bytes = this.#readFile(join(folder, recordName(1))); }
        catch (readError) { throw new JournalStateError('journal_history_gap', readError); }
      }
      this.#metrics.discoveryParses++;
      const record = parseContract(recordSchema, JSON.parse(bytes.toString('utf8'))); const input = validateCommit(record.request as CommitRequest);
      if (this.#key(input.workId) !== name) throw new JournalStateError('journal_work_identity_invalid');
      return this.#replay(input.workId).state;
  }
  #all(): WorkState[] {
    const states: WorkState[] = [];
    for (const name of this.#directories()) { const state = this.#readWork(name); if (state) states.push(state); }
    this.#fence(); return states;
  }
  async workIdsForConversation(tenantId: string, principalId: string, channel: string, conversationId: string) {
    return this.#all().filter(s => s.policy.tenantId === tenantId && s.policy.principalId === principalId && s.conversation?.bindings.some(b => b.channel === channel && b.conversationId === conversationId && b.tenantId === tenantId && b.principalId === principalId)).map(s => s.id).sort();
  }
  async conversationWorkPage(input: ConversationWorkQuery) {
    const query = validateConversationQuery(input); const after = decodeStateQueryCursor('journal-v1', query);
    if (after !== null && !/^[a-f0-9]{64}$/.test(after)) throw new Error('invalid_state_query');
    const names = this.#directories(); let start = 0;
    while (start < names.length && after !== null && names[start]! <= after) start++;
    const candidates = names.slice(start, start + query.limit); const workIds: string[] = [];
    for (const name of candidates) { const state = this.#readWork(name); if (state && matchesConversation(state, query)) workIds.push(state.id); }
    this.#fence();
    return { workIds, nextCursor: start + candidates.length < names.length ? encodeStateQueryCursor('journal-v1', query, candidates.at(-1)!) : null };
  }
  async runnable(now: number) {
    return this.#all().filter(s => ['ready', 'running'].includes(s.status) || s.attempts.some(a => a.status === 'received' || (['reserved', 'running'].includes(a.status) && a.leaseUntil <= now)) ||
      s.modelCalls.some(c => c.status === 'received' || (['reserved', 'running'].includes(c.status) && (c.expired || c.leaseUntil <= now))) ||
      (s.status === 'waiting' && (s.deadlineAt <= now || (s.retryWakeAt != null && s.retryWakeAt <= now) || s.obligations.some(o => o.status === 'pending' && o.dueAt !== null && o.dueAt <= now)))).map(s => s.id).sort();
  }
  async close() { this.#closed = true; this.#cache.clear(); this.#cacheBytes = 0; this.#workDirectories.clear(); this.#knownWorkIds.clear(); this.#observedHeads.clear(); this.#windows?.close(); }
}
