import { win32 } from 'node:path';
import { FileBoundaryFault, hostMetadataFiles, type MetadataAccess, type MetadataDirectory } from './host-metadata-files.js';
import { FileMutationFault, type FileMutationFailure, type FileMutationStatus, type FilePublicationResult,
  type HostFileMutations, type HostFileMutationScope } from './host-file-mutations.js';
import { WindowsMetadataFiles, windowsAbsolutePath } from './windows-metadata-files.js';
import { windowsFileFault, type WindowsDurability } from './windows-file-addon.js';

const inside = (root: string, target: string) => {
  const tail = win32.relative(root.toUpperCase(), target.toUpperCase());
  return !tail || tail !== '..' && !tail.startsWith('..\\') && !win32.isAbsolute(tail);
};
const status = (): FileMutationStatus => ({ publication: 'not_published', created: false, fileSynced: false, directorySynced: false, cleanup: 'not_needed' });
type Entry = { path: string; reference: MetadataDirectory };

class WindowsMutationScope implements HostFileMutationScope {
  readonly #root: string;
  readonly #canonicalRoot: string;
  readonly #forbidden: readonly string[];
  readonly #entries = new Map<string, Entry>();
  readonly #refs = new WeakMap<MetadataDirectory, Entry>();
  readonly #anchor: Entry;
  #closed = false;
  constructor(readonly files: WindowsMetadataFiles, options: { root: string; forbiddenRoots: readonly string[] }, readonly durability: WindowsDurability) {
    // Existing consumers require a directory barrier. They must explicitly adopt the weaker policy before any creation.
    if (durability !== 'process-crash') throw new FileBoundaryFault('unsupported_platform', 'sync', new Error('namespace_durability_unsupported'));
    this.#root = windowsAbsolutePath(options.root);
    if (win32.dirname(this.#root) === this.#root || !Array.isArray(options.forbiddenRoots)) throw new FileBoundaryFault('invalid_request', 'directory');
    this.#forbidden = Object.freeze(options.forbiddenRoots.map(windowsAbsolutePath));
    const path = win32.dirname(this.#root), reference = files.inspectDirectory(path, 'traverse');
    if (!reference) throw new FileBoundaryFault('missing', 'directory');
    this.#anchor = { path, reference };
    try {
      this.#canonicalRoot = win32.join(files.handle(reference).check().path, win32.basename(this.#root));
      this.#guard();
      const root = files.inspectDirectory(this.#root, 'owner-writable'); if (root) this.#remember(this.#root, root);
    } catch (error) {
      try { files.closeDirectory(reference); }
      catch (close) { throw new AggregateError([error, close], 'windows_mutation_scope_open_failed'); }
      throw error;
    }
  }
  #remember(path: string, reference: MetadataDirectory) {
    const entry = { path, reference }; this.#entries.set(path.toUpperCase(), entry); this.#refs.set(reference, entry); return reference;
  }
  #canonical(path: string): string {
    let current = path; const missing: string[] = [];
    for (;;) {
      const reference = this.files.inspectDirectory(current, 'traverse');
      if (reference) {
        try { return win32.join(this.files.handle(reference).check().path, ...missing.reverse()); }
        finally { this.files.closeDirectory(reference); }
      }
      const parent = win32.dirname(current); if (parent === current) throw new FileBoundaryFault('missing', 'directory');
      missing.push(win32.basename(current)); current = parent;
    }
  }
  #guard() {
    if (this.#closed) throw new FileBoundaryFault('invalid_request', 'directory');
    this.files.handle(this.#anchor.reference);
    if (this.#canonical(this.#root).toUpperCase() !== this.#canonicalRoot.toUpperCase()) throw new FileBoundaryFault('changed', 'directory');
    for (const forbidden of this.#forbidden) {
      const actual = this.#canonical(forbidden);
      if (inside(actual, this.#canonicalRoot) || inside(this.#canonicalRoot, actual)) throw new FileBoundaryFault('unsafe', 'directory');
    }
    for (const entry of this.#entries.values()) this.files.handle(entry.reference);
  }
  check(): void { this.#guard(); }
  directory(path: string, access: MetadataAccess, create = false, exclusive = false): MetadataDirectory | null {
    windowsAbsolutePath(path);
    if (!inside(this.#root, path) || !['private', 'owner-writable'].includes(access) || typeof create !== 'boolean' ||
      typeof exclusive !== 'boolean' || exclusive && !create) throw new FileBoundaryFault('invalid_request', 'directory');
    this.#guard();
    const existing = this.#entries.get(path.toUpperCase()); if (existing && !exclusive) return existing.reference;
    const parentPath = win32.dirname(path);
    const parent = parentPath.toUpperCase() === this.#anchor.path.toUpperCase() ? this.#anchor.reference :
      this.#entries.get(parentPath.toUpperCase())?.reference ?? this.directory(parentPath, 'owner-writable');
    if (!parent) throw new FileBoundaryFault('missing', 'directory');
    try {
      const native = this.files.handle(parent).childDirectory(win32.basename(path), create, exclusive, this.durability);
      if (!native) return null;
      const reference = this.files.reference(native, path, access); this.#remember(path, reference); this.#guard(); return reference;
    } catch (error) {
      if (!create) throw windowsFileFault(error, 'directory');
      if (exclusive && error instanceof Error && /windows_file:win32_io:create_directory:(80|183)\b/.test(error.message))
        throw Object.assign(new Error('directory_exists', { cause: error }), { code: 'EEXIST' });
      throw new FileMutationFault('directory', 'native_directory', { ...status(), created: 'unknown' }, [{ stage: 'native_directory', error }]);
    }
  }
  publish(directory: MetadataDirectory, leaf: string, input: Uint8Array, options: { executable?: boolean } = {}): FilePublicationResult {
    if (!this.#refs.has(directory) || !(input instanceof Uint8Array) || options.executable !== undefined && options.executable !== false)
      throw new FileBoundaryFault('invalid_request', 'open');
    this.#guard();
    const native = this.files.handle(directory);
    let outcome;
    try { outcome = native.publish(leaf, Buffer.from(input), this.durability); }
    catch (error) {
      throw new FileMutationFault('publish', 'native_publish', { ...status(), publication: 'unknown', created: 'unknown', cleanup: 'unknown' },
        [{ stage: 'native_publish', error }]);
    }
    const progress: FileMutationStatus = {
      publication: outcome.publication === 'created' ? 'published' : outcome.publication === 'unknown' ? 'unknown' : 'not_published',
      created: outcome.candidateName ? true : outcome.phase === 'create_candidate' ? 'unknown' : false,
      fileSynced: outcome.fileFlush === 'completed', directorySynced: false,
      cleanup: outcome.cleanup === 'removed' || outcome.cleanup === 'consumed_by_rename' ? 'removed' :
        outcome.cleanup === 'not_needed' ? 'not_needed' : outcome.cleanup === 'retained_ambiguous' ? 'retained' : 'unknown',
    };
    const errors: FileMutationFailure[] = [];
    if (!outcome.ok) errors.push({ stage: outcome.phase, error: Object.assign(new Error(outcome.code ?? 'windows_publication_failed'), { nativeOutcome: outcome }) });
    if (outcome.cleanupWin32Error !== undefined) errors.push({ stage: 'candidate_cleanup', error: new Error(`win32:${outcome.cleanupWin32Error}`) });
    if (outcome.closeWin32Error !== undefined) errors.push({ stage: 'candidate_close', error: new Error(`win32:${outcome.closeWin32Error}`) });
    if (outcome.namespaceBarrier !== 'unsupported') errors.push({ stage: 'namespace_contract', error: new Error('windows_namespace_contract_invalid') });
    try { this.#guard(); } catch (error) { errors.push({ stage: 'check', error }); }
    if (errors.length) throw new FileMutationFault('publish', errors[0]!.stage, progress, errors);
    return Object.freeze({ ...progress, published: progress.publication === 'published' });
  }
  close(): void {
    if (this.#closed) return; this.#closed = true;
    const errors: unknown[] = [];
    for (const reference of [...this.#entries.values()].reverse().map(entry => entry.reference).concat(this.#anchor.reference)) {
      try { this.files.closeDirectory(reference); } catch (error) { errors.push(error); }
    }
    this.#entries.clear();
    if (errors.length) throw new AggregateError(errors, 'windows_mutation_scope_close_failed');
  }
}
export class WindowsFileMutations implements HostFileMutations {
  readonly #files: WindowsMetadataFiles;
  readonly #durability: WindowsDurability;
  constructor(options: { files?: WindowsMetadataFiles; durability?: WindowsDurability } = {}) {
    const files = options.files ?? hostMetadataFiles();
    if (process.platform !== 'win32' || !(files instanceof WindowsMetadataFiles)) throw new FileBoundaryFault('unsupported_platform', 'directory');
    this.#files = files; this.#durability = options.durability ?? 'strict-namespace';
    if (!['strict-namespace', 'process-crash'].includes(this.#durability)) throw new FileBoundaryFault('invalid_request', 'directory');
  }
  openScope(options: { root: string; forbiddenRoots: readonly string[] }): HostFileMutationScope {
    return new WindowsMutationScope(this.#files, options, this.#durability);
  }
}
