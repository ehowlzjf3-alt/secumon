import { opendirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { MemoryDraftContentSchema, MemoryDraftIntentSchema, MemoryDraftOriginSchema, MemoryDraftOwnerSchema,
  type MemoryDraftContent, type MemoryDraftIntent, type MemoryDraftOrigin, type MemoryDraftOwner, type MemoryDraftRepository } from '../application/personal-memory-draft-contracts.js';
import { canonical, sha256 } from './digest.js';
import type { Json } from '../domain/model.js';
import { documentPending, inspectDocumentKnowledgeStore } from './document-knowledge-owner.js';
import { FileBoundaryFault, hostMetadataFiles, metadataFileAllowed, sameFileIdentity, type MetadataDirectory } from './host-metadata-files.js';
import { FileMutationFault, hostFileMutations, type HostFileMutationScope } from './host-file-mutations.js';

export class MemoryDraftFileError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) { super(code, options); }
}
export const memoryDraftFileLimits = Object.freeze({ entries: 4096, bytes: 64 * 1024 * 1024, file: 256 * 1024,
  pending: 512, pendingBytes: 64 * 1024 * 1024, retries: 8 });
const uuid = z.uuid();
const fileName = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}\.(?:origin\.json|intent\.json|md)$/;
const jsonBytes = (value: unknown) => Buffer.from(canonical(JSON.parse(JSON.stringify(value)) as Json));
const equal = (left: unknown, right: unknown) => jsonBytes(left).equals(jsonBytes(right));
const fail = (code: string): never => { throw new MemoryDraftFileError(`personal_memory_draft_${code}`); };
const transient = (error: unknown) => error instanceof FileBoundaryFault && ['missing', 'changed'].includes(error.code) && ['read', 'open'].includes(error.operation);
type Options = { root: string; runtimeRoot: string; agentId: string; storeId: string; memoryDirectory: string };
type Open = { scope: HostFileMutationScope; path: string; ref: MetadataDirectory | null };
type Scan = { entries: Map<string, Buffer>; bytes: number };

/** A small inert front matter, not a YAML interpreter. The Markdown body remains exact user text. */
export function encodeMemoryDraft(title: string, body: string): Buffer {
  return Buffer.from(`---\nsecumon-memory-draft: 1\ntitle: ${JSON.stringify(title)}\n---\n${body}`, 'utf8');
}
function decodeMemoryDraft(bytes: Buffer, origin: MemoryDraftOrigin): MemoryDraftContent {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const matched = /^---\r?\nsecumon-memory-draft: 1\r?\ntitle: ([^\n]*)\r?\n---\r?\n([\s\S]*)$/.exec(text);
    if (!matched) throw new Error('invalid_draft_front_matter');
    return MemoryDraftContentSchema.parse({ origin, title: JSON.parse(matched[1]!), body: matched[2] });
  } catch (cause) { throw new MemoryDraftFileError('personal_memory_draft_invalid', { cause }); }
}

/** Editable drafts are never knowledge records. Each operation closes its host mutation scope. */
export class FilePersonalMemoryDrafts implements MemoryDraftRepository {
  readonly #options: Readonly<Options>;
  constructor(options: Options) {
    const parsed = z.strictObject({ root: z.string().min(1), runtimeRoot: z.string().min(1), agentId: z.string().min(1).max(256),
      storeId: uuid, memoryDirectory: z.string().min(1) }).parse(options);
    const root = resolve(parsed.root), memoryDirectory = resolve(parsed.memoryDirectory), tail = relative(root, memoryDirectory);
    if (Object.values(parsed).some(value => value.includes('\0')) || !tail || tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail)) fail('owner_mismatch');
    this.#options = Object.freeze({ ...parsed, root, memoryDirectory, runtimeRoot: resolve(parsed.runtimeRoot) });
  }
  #owner(value: MemoryDraftOwner): MemoryDraftOwner {
    const owner = MemoryDraftOwnerSchema.parse(value);
    if (owner.agentId !== this.#options.agentId) fail('owner_mismatch');
    return owner;
  }
  #open(owner: MemoryDraftOwner, create: boolean): Open {
    const { root, runtimeRoot, memoryDirectory, agentId, storeId } = this.#options;
    const scope = hostFileMutations().openScope({ root, forbiddenRoots: [runtimeRoot] });
    try {
      if (inspectDocumentKnowledgeStore(join(memoryDirectory, 'documents'), { root, agentId, storeId }) !== 'registered') fail('owner_mismatch');
      if (!scope.directory(root, 'owner-writable')) fail('missing');
      let path = root;
      for (const part of relative(root, memoryDirectory).split(sep)) {
        path = join(path, part); if (!scope.directory(path, 'private')) fail('missing');
      }
      const parent = join(memoryDirectory, 'drafts'), target = join(parent, sha256(jsonBytes(owner)));
      const parentRef = scope.directory(parent, 'private', create);
      const ref = parentRef ? scope.directory(target, 'private', create) : null;
      return { scope, path: target, ref };
    } catch (error) { scope.close(); throw error; }
  }
  #check(open: Open) {
    open.scope.check();
    if (open.ref && !hostMetadataFiles().inspectDirectory(open.path, 'private', open.ref)) throw new FileBoundaryFault('changed', 'directory');
  }
  #names(open: Open): string[] {
    this.#check(open); const names: string[] = []; const directory = opendirSync(open.path);
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (names.length >= memoryDraftFileLimits.entries + memoryDraftFileLimits.pending) fail('limit_exceeded');
        names.push(entry.name);
      }
    } finally { directory.closeSync(); }
    this.#check(open); return names.sort();
  }
  #read(open: Open, name: string, names: string[]): Buffer {
    this.#check(open);
    const bytes = hostMetadataFiles().readStableRegularFile(open.ref!, name, { access: 'private', maximum: memoryDraftFileLimits.file,
      allowLinkedFile: (file, siblings) => {
        if (file.links !== 2n) return false;
        for (const other of names) {
          if (documentPending.test(other) === documentPending.test(name)) continue;
          const peer = siblings.inspect(other);
          if (peer && metadataFileAllowed(peer, 'private') && peer.links === 2n && peer.size === file.size && sameFileIdentity(peer.identity, file.identity)) return true;
        }
        return false;
      } });
    this.#check(open); return bytes;
  }
  #scan(open: Open): Scan {
    if (!open.ref) return { entries: new Map(), bytes: 0 };
    for (let retry = 0; ; retry++) {
      try {
        const names = this.#names(open), entries = new Map<string, Buffer>(); let bytes = 0, pending = 0, pendingBytes = 0;
        for (const name of names) {
          if (!fileName.test(name) && !documentPending.test(name)) fail('invalid');
          const read = this.#read(open, name, names);
          if (documentPending.test(name)) {
            if (++pending > memoryDraftFileLimits.pending || (pendingBytes += read.length) > memoryDraftFileLimits.pendingBytes) fail('limit_exceeded');
          } else {
            entries.set(name, read); bytes += read.length;
            if (entries.size > memoryDraftFileLimits.entries || bytes > memoryDraftFileLimits.bytes) fail('limit_exceeded');
          }
        }
        if (!equal(names, this.#names(open))) throw new MemoryDraftFileError('personal_memory_draft_contention');
        return { entries, bytes };
      } catch (error) {
        if (retry + 1 >= memoryDraftFileLimits.retries || !transient(error) && !(error instanceof MemoryDraftFileError && error.code === 'personal_memory_draft_contention')) throw error;
      }
    }
  }
  #origin(bytes: Buffer | undefined, owner: MemoryDraftOwner, draftId: string): MemoryDraftOrigin {
    if (!bytes) fail('missing');
    let value: MemoryDraftOrigin;
    try { value = MemoryDraftOriginSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
    catch (cause) { throw new MemoryDraftFileError('personal_memory_draft_invalid', { cause }); }
    if (!equal(value.owner, owner) || value.storeId !== this.#options.storeId || value.draftId !== draftId) fail('owner_mismatch');
    return value;
  }
  #intent(bytes: Buffer, owner: MemoryDraftOwner, applyId: string, scan: Scan): MemoryDraftIntent {
    let value: MemoryDraftIntent;
    try { value = MemoryDraftIntentSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
    catch (cause) { throw new MemoryDraftFileError('personal_memory_draft_invalid', { cause }); }
    if (value.applyId !== applyId || !equal(value.origin, this.#origin(scan.entries.get(`${value.origin.draftId}.origin.json`), owner, value.origin.draftId))) fail('owner_mismatch');
    const unchanged = value.title === value.origin.baseTitle && sha256(Buffer.from(value.body, 'utf8')) === value.origin.baseBodyDigest;
    if (value.action !== (unchanged ? 'unchanged' : 'revise')) fail('invalid');
    return value;
  }
  #capacity(scan: Scan, additions: Map<string, Buffer>) {
    let count = scan.entries.size, total = scan.bytes;
    for (const [name, bytes] of additions) {
      if (bytes.length > memoryDraftFileLimits.file) fail('limit_exceeded');
      if (!scan.entries.has(name)) { count++; total += bytes.length; }
    }
    if (count > memoryDraftFileLimits.entries || total > memoryDraftFileLimits.bytes) fail('limit_exceeded');
  }
  #barrier(open: Open) {
    if (!open.ref) return;
    try { hostMetadataFiles().syncDirectory(open.ref); this.#check(open); }
    catch (error) { throw new FileMutationFault('publish', 'draft_existing_barrier', { publication: 'published', created: false,
      fileSynced: false, directorySynced: false, cleanup: 'not_needed' }, [{ stage: 'draft_existing_barrier', error }]); }
  }
  #publish(open: Open, name: string, bytes: Buffer, preserveExisting = false) {
    const before = this.#scan(open); this.#capacity(before, new Map([[name, bytes]]));
    const existing = before.entries.get(name);
    if (existing) { if (!preserveExisting && !existing.equals(bytes)) fail('conflict'); this.#barrier(open); return; }
    const result = open.scope.publish(open.ref!, name, bytes);
    try {
      const actual = this.#scan(open).entries.get(name);
      if (!actual || !preserveExisting && !actual.equals(bytes)) fail('conflict');
      this.#barrier(open);
    } catch (error) {
      if (!result.published) throw error;
      throw new FileMutationFault('publish', 'draft_publication_check', result, [{ stage: 'draft_publication_check', error }]);
    }
  }
  async create(value: MemoryDraftOwner, input: { draftId: string; memoryId: string; baseRevision: number; title: string; body: string }) {
    const owner = this.#owner(value);
    const origin = MemoryDraftOriginSchema.parse({ schemaVersion: 1, draftId: input.draftId, owner, storeId: this.#options.storeId,
      memoryId: input.memoryId, baseRevision: input.baseRevision, baseTitle: input.title, baseBodyDigest: sha256(Buffer.from(input.body, 'utf8')) });
    const content = MemoryDraftContentSchema.parse({ origin, title: input.title, body: input.body });
    const originName = `${origin.draftId}.origin.json`, name = `${origin.draftId}.md`, bytes = encodeMemoryDraft(content.title, content.body);
    const open = this.#open(owner, true);
    try {
      const before = this.#scan(open), old = before.entries.get(originName);
      if (old && !old.equals(jsonBytes(origin))) fail('conflict');
      if (!old && before.entries.has(name)) fail('invalid');
      this.#capacity(before, new Map([[originName, jsonBytes(origin)], [name, bytes]]));
      this.#publish(open, originName, jsonBytes(origin));
      this.#publish(open, name, bytes, true);
      this.#barrier(open); return { origin: structuredClone(origin), path: join(open.path, name) };
    } finally { open.scope.close(); }
  }
  async read(value: MemoryDraftOwner, draftId: string): Promise<MemoryDraftContent> {
    const owner = this.#owner(value); uuid.parse(draftId); const open = this.#open(owner, false);
    try {
      const scan = this.#scan(open), origin = this.#origin(scan.entries.get(`${draftId}.origin.json`), owner, draftId), bytes = scan.entries.get(`${draftId}.md`);
      if (!bytes) return fail('missing'); const result = decodeMemoryDraft(bytes, origin); this.#barrier(open); return result;
    } finally { open.scope.close(); }
  }
  async bind(value: MemoryDraftOwner, input: MemoryDraftIntent): Promise<MemoryDraftIntent> {
    const owner = this.#owner(value), intent = MemoryDraftIntentSchema.parse(input), open = this.#open(owner, false);
    try {
      const scan = this.#scan(open), bytes = jsonBytes(intent), name = `${intent.applyId}.intent.json`;
      this.#intent(bytes, owner, intent.applyId, scan);
      this.#publish(open, name, bytes); return structuredClone(intent);
    } finally { open.scope.close(); }
  }
  async operation(value: MemoryDraftOwner, applyId: string): Promise<MemoryDraftIntent | null> {
    const owner = this.#owner(value); uuid.parse(applyId); const open = this.#open(owner, false);
    try {
      const scan = this.#scan(open), bytes = scan.entries.get(`${applyId}.intent.json`); if (!bytes) return null;
      const intent = this.#intent(bytes, owner, applyId, scan); this.#barrier(open); return intent;
    } finally { open.scope.close(); }
  }
}
