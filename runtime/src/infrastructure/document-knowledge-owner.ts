import { lstatSync, opendirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { hostFileMutations, type HostFileMutationScope } from './host-file-mutations.js';
import { FileBoundaryFault, hostMetadataFiles, metadataFileAllowed, sameFileIdentity, completeMetadataPublication, hostFileDurabilityPolicy, type MetadataDirectory } from './host-metadata-files.js';
import { DocumentKnowledgeError, documentDigest, documentLimits, documentName } from './document-knowledge-codec.js';
import { decodeDocumentImportManifest, documentImportedFormatSchema, type DocumentStoreDescriptor } from './document-knowledge-import-codec.js';
import { sha256 } from './digest.js';
import { WindowsMetadataFiles } from './windows-metadata-files.js';
import { windowsPathInfo } from './windows-profile-files.js';
export { DocumentKnowledgeError } from './document-knowledge-codec.js';

const bindingSchema = z.strictObject({ agentId: documentName, storeId: documentName, root: z.string().min(1).optional() });
export type DocumentKnowledgeBinding = z.infer<typeof bindingSchema>;
const ownerSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('document-knowledge'), agentId: documentName, storeId: documentName });
const format = Object.freeze({ schemaVersion: 1, format: 'immutable-markdown-namespace-v1' });
export const documentPending = /^\.secumon-init-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pending$/;
export const namespaceDirectory = /^ns-[a-f0-9]{64}$/;
export const documentWitnessDirectory = /^witness-[a-f0-9]{64}$/;
const namesEqual = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => value === b[index]);
export { namesEqual as documentNamesEqual };
export function documentBinding(directory: string, value: DocumentKnowledgeBinding) {
  const parsed = bindingSchema.parse(value), path = resolve(directory), root = resolve(parsed.root ?? path), tail = relative(root, path);
  if (!directory || directory.includes('\0') || tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw new DocumentKnowledgeError('document_knowledge_root_mismatch');
  return { directory: path, binding: Object.freeze({ ...parsed, root }) };
}
/** POSIX path rechecks or retained Win32 handles under the explicit host durability policy. */
export class DocumentFiles {
  readonly files = hostMetadataFiles();
  readonly durability = hostFileDurabilityPolicy();
  readonly scope: HostFileMutationScope;
  readonly directory: string;
  readonly binding: Readonly<DocumentKnowledgeBinding & { root: string }>;
  readonly #directoryRefs = new Map<string, MetadataDirectory>();
  constructor(directory: string, binding: DocumentKnowledgeBinding) {
    const selected = documentBinding(directory, binding); this.directory = selected.directory; this.binding = selected.binding;
    this.scope = hostFileMutations().openScope({ root: this.binding.root, forbiddenRoots: [] });
  }
  directoryRef(path: string, create = false): MetadataDirectory | null {
    const target = resolve(path), tail = relative(this.binding.root, target);
    if (tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw new DocumentKnowledgeError('document_knowledge_root_mismatch');
    const rootAccess = this.binding.root === this.directory ? 'private' : 'owner-writable';
    const retained = create === false ? this.#directoryRefs.get(target) : undefined;
    if (retained) {
      // Retain only a scope-owned identity. Every hit still checks current ancestors, access and the named object.
      this.scope.check();
      if (this.files instanceof WindowsMetadataFiles) this.files.handle(retained);
      else if (!this.files.inspectDirectory(target, tail ? 'private' : rootAccess, retained)) throw new FileBoundaryFault('changed', 'directory');
      return retained;
    }
    let ref = this.scope.directory(this.binding.root, rootAccess, create); if (!ref) return null;
    let parent = this.binding.root;
    for (const leaf of tail ? tail.split(sep) : []) {
      parent = join(parent, leaf); ref = this.scope.directory(parent, 'private', create); if (!ref) return null;
    }
    if (this.#directoryRefs.has(target) || this.#directoryRefs.size < 64) this.#directoryRefs.set(target, ref);
    return ref;
  }
  check(path: string, ref: MetadataDirectory) {
    this.scope.check();
    if (!this.files.inspectDirectory(path, 'private', ref)) throw new FileBoundaryFault('changed', 'directory');
  }
  names(path: string, ref: MetadataDirectory, maximum = documentLimits.entries + documentLimits.pending + 2): string[] {
    this.check(path, ref);
    if (this.files instanceof WindowsMetadataFiles) {
      const names = this.files.names(ref, maximum); this.check(path, ref); return names.sort();
    }
    const result: string[] = []; const directory = opendirSync(path);
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (result.length >= maximum) throw new DocumentKnowledgeError('document_knowledge_limit_exceeded');
        result.push(entry.name);
      }
    } finally { directory.closeSync(); }
    this.check(path, ref); return result.sort();
  }
  read(path: string, ref: MetadataDirectory, name: string, names: string[], maximum = documentLimits.file): Buffer {
    this.check(path, ref);
    let bytes: Buffer;
    try {
      bytes = this.files.readStableRegularFile(ref, name, { maximum, access: 'private', allowLinkedFile: (file, siblings) => {
        if (file.links !== 2n) return false;
        const pending = documentPending.test(name);
        for (const sibling of names) {
          if (sibling === name || documentPending.test(sibling) === pending) continue;
          const peer = siblings.inspect(sibling);
          if (peer && metadataFileAllowed(peer, 'private') && peer.links === 2n && peer.size === file.size && sameFileIdentity(file.identity, peer.identity)) return true;
        }
        return false;
      } });
    } catch (error) {
      // A publisher may have linked the candidate after enumeration. Restart full caller validation; never expand the captured peer list here.
      if (error instanceof FileBoundaryFault && error.code === 'unsafe' && error.operation === 'read' &&
        !namesEqual(names, this.names(path, ref))) {
        throw new FileBoundaryFault('changed', 'read', error);
      }
      throw error;
    }
    this.check(path, ref); return bytes;
  }
  token(path: string): string {
    if (process.platform === 'win32') {
      const info = windowsPathInfo(path); if (!info) throw new FileBoundaryFault('missing', 'read'); return info.changeToken;
    }
    const s = lstatSync(path, { bigint: true });
    return [s.dev, s.ino, s.mode, s.uid, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(':');
  }
  pending(path: string, ref: MetadataDirectory, names: string[]) {
    let count = 0, total = 0;
    for (const name of names.filter(value => documentPending.test(value))) {
      if (++count > documentLimits.pending) throw new DocumentKnowledgeError('document_knowledge_limit_exceeded');
      total += this.read(path, ref, name, names).length;
      if (total > documentLimits.pendingBytes) throw new DocumentKnowledgeError('document_knowledge_limit_exceeded');
    }
  }
  sync(ref: MetadataDirectory) { this.scope.check(); const barrier = completeMetadataPublication(this.files, ref); this.scope.check(); return barrier; }
  close() { this.#directoryRefs.clear(); this.scope.close(); }
}
const owner = (binding: DocumentKnowledgeBinding) => ({ schemaVersion: 1, kind: 'document-knowledge', agentId: binding.agentId, storeId: binding.storeId });
class RootPendingChanged extends Error {
  constructor(readonly failure: FileBoundaryFault) { super('document_knowledge_pending_changed', { cause: failure }); }
}
function rootPendingObservation<T>(read: () => T): T {
  try { return read(); }
  catch (error) {
    if (error instanceof FileBoundaryFault && ['open', 'read'].includes(error.operation) && ['missing', 'changed'].includes(error.code)) throw new RootPendingChanged(error);
    throw error;
  }
}
function readRootView(files: DocumentFiles, ref: MetadataDirectory, names: string[], initialization: boolean, expectedManifest?: Buffer): 'empty' | 'owner' | 'importing' | 'registered' {
  if (names.filter(name => !documentPending.test(name)).length > documentLimits.roots + 2) throw new DocumentKnowledgeError('document_knowledge_limit_exceeded');
  if (names.length === 0) return 'empty';
  if (names.some(name => name !== 'owner.json' && name !== 'format.json' && name !== 'import-manifest.json' && !namespaceDirectory.test(name) && !documentWitnessDirectory.test(name) && !documentPending.test(name))) throw new DocumentKnowledgeError('document_knowledge_registration_invalid');
  if (!names.includes('owner.json')) {
    if (!initialization || names.some(name => !documentPending.test(name))) throw new DocumentKnowledgeError('document_knowledge_registration_incomplete');
    rootPendingObservation(() => files.pending(files.directory, ref, names));
    // A candidate is not adopted or removed. Only a complete expected owner candidate permits explicit recovery.
    for (const name of names) {
      try {
        const candidate = JSON.parse(rootPendingObservation(() => files.read(files.directory, ref, name, names, 4096)).toString('utf8'));
        if (documentDigest(ownerSchema.parse(candidate)) !== documentDigest(owner(files.binding))) throw new Error('owner_candidate_mismatch');
      } catch (cause) {
        if (cause instanceof RootPendingChanged) throw cause;
        throw new DocumentKnowledgeError('document_knowledge_registration_cleanup_required', { cause });
      }
    }
    return 'empty';
  }
  let actual: unknown;
  try { actual = ownerSchema.parse(JSON.parse(files.read(files.directory, ref, 'owner.json', names, 4096).toString('utf8'))); }
  catch (cause) { if (cause instanceof FileBoundaryFault) throw cause; throw new DocumentKnowledgeError('document_knowledge_owner_invalid', { cause }); }
  if (documentDigest(actual) !== documentDigest(owner(files.binding))) throw new DocumentKnowledgeError('document_knowledge_owner_mismatch');
  rootPendingObservation(() => files.pending(files.directory, ref, names));
  const manifestBytes = names.includes('import-manifest.json') ? files.read(files.directory, ref, 'import-manifest.json', names) : null;
  const manifest = manifestBytes ? decodeDocumentImportManifest(manifestBytes) : null;
  if (manifest && (manifest.agentId !== files.binding.agentId || manifest.storeId !== files.binding.storeId)) throw new DocumentKnowledgeError('document_knowledge_owner_mismatch');
  if (expectedManifest && manifestBytes && !manifestBytes.equals(expectedManifest)) throw new DocumentKnowledgeError('document_knowledge_import_conflict');
  if (!names.includes('format.json')) {
    if (manifest) {
      if (!expectedManifest) throw new DocumentKnowledgeError('document_knowledge_registration_incomplete');
      const allowed = new Set(manifest.namespaces.flatMap(ns => [`ns-${documentDigest(ns.scope)}`, `witness-${documentDigest(ns.scope)}`]));
      for (const name of names.filter(value => namespaceDirectory.test(value) || documentWitnessDirectory.test(value))) {
        if (!allowed.has(name) || !files.directoryRef(join(files.directory, name))) throw new DocumentKnowledgeError('document_knowledge_import_conflict');
      }
      return 'importing';
    }
    if (names.some(name => namespaceDirectory.test(name) || documentWitnessDirectory.test(name))) throw new DocumentKnowledgeError('document_knowledge_registration_invalid');
    return 'owner';
  }
  let actualFormat: unknown;
  try { actualFormat = JSON.parse(files.read(files.directory, ref, 'format.json', names, 4096).toString('utf8')); }
  catch (cause) { if (cause instanceof FileBoundaryFault) throw cause; throw new DocumentKnowledgeError('document_knowledge_format_invalid', { cause }); }
  if (documentDigest(actualFormat) === documentDigest(format)) {
    if (manifest || expectedManifest) throw new DocumentKnowledgeError('document_knowledge_import_conflict');
  } else {
    let imported: ReturnType<typeof documentImportedFormatSchema.parse>;
    try { imported = documentImportedFormatSchema.parse(actualFormat); }
    catch (cause) { throw new DocumentKnowledgeError('document_knowledge_format_invalid', { cause }); }
    if (!manifest || imported.initialImport.manifestDigest !== sha256(manifestBytes!) || imported.initialImport.operationId !== manifest.operationId ||
      imported.initialImport.snapshotDigest !== manifest.snapshotDigest) throw new DocumentKnowledgeError('document_knowledge_format_invalid');
    for (const ns of manifest.namespaces) {
      if (!names.includes(`ns-${documentDigest(ns.scope)}`) || !names.includes(`witness-${documentDigest(ns.scope)}`)) throw new DocumentKnowledgeError('document_knowledge_history_missing');
    }
  }
  for (const name of names.filter(value => namespaceDirectory.test(value) || documentWitnessDirectory.test(value))) {
    if (!files.directoryRef(join(files.directory, name))) throw new DocumentKnowledgeError('document_knowledge_registration_invalid');
  }
  files.check(files.directory, ref);
  return 'registered';
}
function rootView(files: DocumentFiles, initialization = false, expectedManifest?: Buffer): 'missing' | 'empty' | 'owner' | 'importing' | 'registered' {
  const ref = files.directoryRef(files.directory); if (!ref) return 'missing';
  let observedOwner = false, observedFormat = false;
  for (let retry = 0; ; retry++) {
    const names = files.names(files.directory, ref, documentLimits.roots + documentLimits.pending + 2);
    if (observedOwner && !names.includes('owner.json') || observedFormat && !names.includes('format.json')) throw new DocumentKnowledgeError('document_knowledge_registration_incomplete');
    observedOwner ||= names.includes('owner.json'); observedFormat ||= names.includes('format.json');
    try { return readRootView(files, ref, names, initialization, expectedManifest); }
    catch (error) {
      if (!(error instanceof RootPendingChanged)) throw error;
      // A competing publisher can remove its candidate. Re-enumerate, but never retry canonical corruption or replace the root.
      if (retry + 1 >= documentLimits.retries) throw error.failure;
    }
  }
}
export function assertDocumentKnowledgeStore(files: DocumentFiles): DocumentStoreDescriptor {
  const result = rootView(files);
  if (result !== 'registered') throw new DocumentKnowledgeError(result === 'missing' ? 'document_knowledge_store_missing' : 'document_knowledge_registration_incomplete');
  const ref = files.directoryRef(files.directory)!, names = files.names(files.directory, ref);
  const bytes = files.read(files.directory, ref, 'format.json', names, 4096);
  const value = JSON.parse(bytes.toString('utf8')) as unknown;
  if (documentDigest(value) === documentDigest(format)) return { schemaVersion: 1 };
  const imported = documentImportedFormatSchema.parse(value);
  const manifestBytes = files.read(files.directory, ref, 'import-manifest.json', names);
  const manifest = decodeDocumentImportManifest(manifestBytes);
  if (imported.initialImport.manifestDigest !== sha256(manifestBytes) || manifest.agentId !== files.binding.agentId || manifest.storeId !== files.binding.storeId ||
    imported.initialImport.operationId !== manifest.operationId || imported.initialImport.snapshotDigest !== manifest.snapshotDigest) throw new DocumentKnowledgeError('document_knowledge_format_invalid');
  return { schemaVersion: 2, format: imported, manifest };
}

/** Only the host migration path supplies the exact manifest. Ordinary registration never opens a partial import. */
export function inspectDocumentImportRoot(files: DocumentFiles, manifestBytes: Buffer): 'missing' | 'incomplete' | 'complete' {
  const manifest = decodeDocumentImportManifest(manifestBytes);
  if (manifest.agentId !== files.binding.agentId || manifest.storeId !== files.binding.storeId) throw new DocumentKnowledgeError('document_knowledge_owner_mismatch');
  const state = rootView(files, true, manifestBytes);
  return state === 'missing' ? 'missing' : state === 'registered' ? 'complete' : 'incomplete';
}
export function inspectUnpreparedDocumentImportRoot(files: DocumentFiles): 'missing' | 'incomplete' {
  const state = rootView(files, true);
  if (state === 'registered' || state === 'importing') throw new DocumentKnowledgeError('document_knowledge_import_conflict');
  return state === 'missing' ? 'missing' : 'incomplete';
}
export function prepareDocumentImportRoot(files: DocumentFiles, manifestBytes: Buffer): 'incomplete' | 'complete' {
  const before = inspectDocumentImportRoot(files, manifestBytes);
  if (before === 'complete') return before;
  const ref = files.directoryRef(files.directory, true)!;
  const initial = rootView(files, true, manifestBytes);
  if (initial === 'empty') files.scope.publish(ref, 'owner.json', Buffer.from(JSON.stringify(owner(files.binding))));
  const owned = rootView(files, false, manifestBytes);
  if (owned !== 'owner' && owned !== 'importing') throw new DocumentKnowledgeError('document_knowledge_registration_incomplete');
  files.scope.publish(ref, 'import-manifest.json', manifestBytes);
  if (rootView(files, false, manifestBytes) !== 'importing') throw new DocumentKnowledgeError('document_knowledge_import_conflict');
  files.sync(ref); files.check(files.directory, ref);
  return 'incomplete';
}
export function inspectDocumentKnowledgeStore(directory: string, binding: DocumentKnowledgeBinding): 'missing' | 'registered' {
  const files = new DocumentFiles(directory, binding);
  try { const result = rootView(files); if (result === 'missing') return result; assertDocumentKnowledgeStore(files); return 'registered'; }
  finally { files.close(); }
}
/** Only this explicit initializer may recover an owner-only registration. */
export function registerDocumentKnowledgeStore(directory: string, binding: DocumentKnowledgeBinding): void {
  const files = new DocumentFiles(directory, binding);
  try {
    const before = rootView(files, true);
    const ref = files.directoryRef(files.directory, true)!;
    if (before === 'missing' || before === 'empty') files.scope.publish(ref, 'owner.json', Buffer.from(JSON.stringify(owner(files.binding))));
    const owned = rootView(files);
    if (owned !== 'owner' && owned !== 'registered') throw new DocumentKnowledgeError('document_knowledge_registration_incomplete');
    if (owned !== 'registered') files.scope.publish(ref, 'format.json', Buffer.from(JSON.stringify(format)));
    assertDocumentKnowledgeStore(files); files.sync(ref); files.check(files.directory, ref);
  } finally { files.close(); }
}
