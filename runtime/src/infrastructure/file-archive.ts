import { opendirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { ArchiveDescriptorSchema, ArchiveMutationSchema, ArchiveOwnerSchema, ArchiveQuerySchema,
  type ArchiveDescriptor, type ArchiveDocument, type ArchiveMutation, type ArchiveMutationResult, type ArchiveOwner, type ArchiveProvider } from '../application/archive-contracts.js';
import { asJson } from '../application/plan-validator.js';
import { frozen } from '../application/resource-contracts.js';
import { canonical, sha256 } from './digest.js';
import { FileBoundaryFault, hostMetadataFiles, completeMetadataPublication, metadataFileAllowed, sameFileIdentity, type MetadataDirectory } from './host-metadata-files.js';
import { hostFileMutations, type HostFileMutationScope } from './host-file-mutations.js';
import { WindowsMetadataFiles } from './windows-metadata-files.js';

const pending = /^\.secumon-init-[a-f0-9-]+\.pending$/;
const recordName = /^\d{8}\.json$/;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const EventSchema = z.strictObject({ schemaVersion: z.literal(1), sequence: z.number().int().positive().max(4096),
  previous: hash.nullable(), command: ArchiveMutationSchema, checksum: hash });
const bytes = (value: unknown) => Buffer.from(canonical(asJson(value)));
const same = (a: unknown, b: unknown) => bytes(a).equals(bytes(b));
const fail = (code: string): never => { throw new Error(`archive_${code}`); };
type Loaded = { documents: Map<string, ArchiveDocument>; receipts: Map<string, { digest: string; result: ArchiveMutationResult }>;
  sequence: number; digest: string | null; totalBytes: number };

/** Dedicated raw-reference format; uses existing host publication primitives, not Knowledge/Evidence encoding. */
export class FileArchiveProvider implements ArchiveProvider {
  readonly descriptor: ArchiveDescriptor;
  readonly #scope: HostFileMutationScope;
  readonly #directory: MetadataDirectory;
  readonly #path: string;
  readonly #ownerBytes: Buffer;
  #closed = false;
  #observed = 0;
  constructor(options: { root: string; owner: ArchiveOwner; descriptor: ArchiveDescriptor }) {
    const owner = ArchiveOwnerSchema.parse(structuredClone(options.owner));
    this.descriptor = frozen(ArchiveDescriptorSchema.parse(structuredClone(options.descriptor)));
    if (this.descriptor.destination !== 'local') fail('local_destination_required');
    const root = resolve(options.root);
    this.#scope = hostFileMutations().openScope({ root, forbiddenRoots: [] });
    this.#path = join(root, 'archive', sha256(bytes({ owner, provider: this.descriptor.id })));
    this.#ownerBytes = bytes({ format: 'archive-reference-v1', owner, descriptor: this.descriptor });
    try {
      if (!this.#scope.directory(root, 'owner-writable')) fail('root_missing');
      this.#scope.directory(join(root, 'archive'), 'private', true);
      this.#directory = this.#scope.directory(this.#path, 'private', true)!;
      const existing = this.#names();
      if (!existing.includes('owner.json')) {
        if (existing.some(name => recordName.test(name))) fail('owner_missing');
        this.#scope.publish(this.#directory, 'owner.json', this.#ownerBytes);
      }
      this.#load();
    } catch (error) { this.#scope.close(); throw error; }
  }
  #check() {
    if (this.#closed) fail('closed');
    this.#scope.check();
    if (!hostMetadataFiles().inspectDirectory(this.#path, 'private', this.#directory)) fail('directory_changed');
  }
  #names(): string[] {
    this.#check(); const files = hostMetadataFiles(), names: string[] = [];
    const add = (name: string) => {
      if (names.length >= 4096 + 129) fail('capacity');
      if (name !== 'owner.json' && !recordName.test(name) && !pending.test(name)) fail('storage_invalid');
      names.push(name);
    };
    if (files instanceof WindowsMetadataFiles) {
      for (const name of files.names(this.#directory, 4096 + 129)) add(name);
    } else {
      const directory = opendirSync(this.#path);
      try { for (let next = directory.readSync(); next; next = directory.readSync()) add(next.name); }
      finally { directory.closeSync(); }
    }
    this.#check(); return names.sort();
  }
  #read(name: string): Buffer {
    const result = hostMetadataFiles().readStableRegularFile(this.#directory, name, { access: 'private', maximum: 512 * 1024,
      allowLinkedFile: (file, siblings) => {
        if (file.links !== 2n) return false;
        for (const other of siblings.names()) {
          if (pending.test(name) === pending.test(other)) continue;
          const peer = siblings.inspect(other);
          if (peer && peer.links === 2n && metadataFileAllowed(peer, 'private') && sameFileIdentity(file.identity, peer.identity)) return true;
        }
        return false;
      } });
    this.#check(); return result;
  }
  #load(): Loaded {
    for (let retry = 0; ; retry++) {
      try {
        const names = this.#names();
        if (!names.includes('owner.json') || !this.#read('owner.json').equals(this.#ownerBytes)) fail('owner_mismatch');
        const loaded: Loaded = { documents: new Map(), receipts: new Map(), sequence: 0, digest: null, totalBytes: 0 };
        let pendingCount = 0;
        for (const name of names) {
          if (name === 'owner.json') continue;
          const raw = this.#read(name); loaded.totalBytes += raw.length;
          if (loaded.totalBytes > 64 * 1024 * 1024) fail('capacity');
          if (pending.test(name)) { if (++pendingCount > 128) fail('capacity'); continue; }
          const event = EventSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
          const { checksum, ...body } = event;
          if (name !== `${String(loaded.sequence + 1).padStart(8, '0')}.json` || event.sequence !== loaded.sequence + 1 ||
            event.previous !== loaded.digest || checksum !== sha256(bytes(body))) fail('storage_invalid');
          const command = event.command, previous = loaded.documents.get(command.id);
          if (loaded.receipts.has(command.commandId)) fail('storage_invalid');
          this.#validateMutation(command, previous);
          const document: ArchiveDocument = command.kind === 'delete' ? { ...previous!, body: '', status: 'deleted', revision: previous!.revision + 1 } :
            { ...command.content, id: command.id, revision: command.expectedRevision + 1, status: 'active' };
          loaded.documents.set(command.id, document);
          loaded.receipts.set(command.commandId, { digest: sha256(bytes(command)), result: { commandId: command.commandId, id: command.id,
            commandDigest: sha256(bytes(command)), revision: document.revision, status: document.status, duplicate: false } });
          loaded.sequence = event.sequence; loaded.digest = sha256(raw);
        }
        if (!same(names, this.#names())) throw new FileBoundaryFault('changed', 'read');
        if (loaded.sequence < this.#observed) fail('storage_rollback');
        completeMetadataPublication(hostMetadataFiles(), this.#directory); this.#check();
        this.#observed = loaded.sequence; return loaded;
      } catch (error) {
        if (retry >= 7 || !(error instanceof FileBoundaryFault) || !['changed', 'missing'].includes(error.code)) throw error;
      }
    }
  }
  #validateMutation(command: ArchiveMutation, previous: ArchiveDocument | undefined) {
    if (command.kind === 'register' ? previous !== undefined : !previous || previous.status !== 'active' || previous.revision !== command.expectedRevision) {
      fail('revision_conflict');
    }
  }
  async get(id: string, signal: AbortSignal) {
    signal.throwIfAborted(); const document = this.#load().documents.get(id);
    return document?.status === 'active' ? structuredClone(document) : null;
  }
  async search(query: Parameters<ArchiveProvider['search']>[0], signal: AbortSignal) {
    signal.throwIfAborted(); const input = ArchiveQuerySchema.parse(query), text = input.query.normalize('NFC').toLocaleLowerCase('en-US');
    const documents = [...this.#load().documents.values()].filter(doc => doc.status === 'active' &&
      `${doc.title}\n${doc.body}\n${doc.path}`.normalize('NFC').toLocaleLowerCase('en-US').includes(text)).sort((a, b) => a.id.localeCompare(b.id));
    return { documents: structuredClone(documents.slice(0, input.limit)), truncated: documents.length > input.limit };
  }
  async receipt(commandId: string, signal: AbortSignal): Promise<ArchiveMutationResult | null> {
    signal.throwIfAborted();
    const id = ArchiveMutationSchema.options[0].shape.commandId.parse(commandId);
    const receipt = this.#load().receipts.get(id);
    return receipt ? structuredClone(receipt.result) : null;
  }
  async mutate(input: ArchiveMutation, signal: AbortSignal): Promise<ArchiveMutationResult> {
    if (this.descriptor.access !== 'read_register') fail('read_only');
    const command = ArchiveMutationSchema.parse(structuredClone(input)), digest = sha256(bytes(command));
    for (let retry = 0; retry < 8; retry++) {
      signal.throwIfAborted(); const loaded = this.#load(), previous = loaded.receipts.get(command.commandId);
      if (previous) { if (previous.digest !== digest) fail('idempotency_conflict'); return { ...previous.result, duplicate: true }; }
      this.#validateMutation(command, loaded.documents.get(command.id));
      if (loaded.sequence >= 4096) fail('capacity');
      const body = { schemaVersion: 1, sequence: loaded.sequence + 1, previous: loaded.digest, command };
      const raw = bytes({ ...body, checksum: sha256(bytes(body)) });
      if (raw.length > 512 * 1024 || raw.length + loaded.totalBytes > 64 * 1024 * 1024) fail('capacity');
      signal.throwIfAborted(); this.#check();
      const publication = this.#scope.publish(this.#directory, `${String(body.sequence).padStart(8, '0')}.json`, raw);
      if (!publication.published) continue;
      this.#observed = body.sequence;
      return { commandId: command.commandId, id: command.id, revision: command.expectedRevision + 1,
        commandDigest: digest, status: command.kind === 'delete' ? 'deleted' : 'active', duplicate: false };
    }
    return fail('contention');
  }
  async close() { if (this.#closed) return; this.#closed = true; this.#scope.close(); }
}
