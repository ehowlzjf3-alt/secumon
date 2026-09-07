import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileBoundaryFault, hostMetadataFiles, sameFileIdentity, type HostMetadataFiles, type MetadataAccess, type MetadataDirectory } from './host-metadata-files.js';
import { FileMutationFault, type FileMutationFailure, type FileMutationStatus, type FilePublicationResult, type HostFileMutations, type HostFileMutationScope } from './host-file-mutations.js';

type Entry = { path: string; access: MetadataAccess | 'sync' | 'traverse'; reference: MetadataDirectory };
const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const creationRejected = new Set(['ENOENT', 'EACCES', 'EPERM', 'EROFS', 'EEXIST', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG', 'EINVAL']);
const inside = (root: string, path: string) => { const tail = relative(root, path); return tail === '' || tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail); };
const fileIdentity = (stat: BigIntStats) => ({ volume: String(stat.dev), object: String(stat.ino) });
const fileToken = (stat: BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const status = (): FileMutationStatus => ({ publication: 'not_published', created: false, fileSynced: false, directorySynced: false, cleanup: 'not_needed' });
function validPath(path: string) {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw new FileBoundaryFault('invalid_request', 'directory');
  return resolve(path);
}
function canonical(path: string): string {
  let current = validPath(path); const missing: string[] = [];
  for (;;) {
    try { return join(realpathSync(current), ...missing.reverse()); }
    catch (error) {
      if (errno(error) !== 'ENOENT' || dirname(current) === current) throw error;
      missing.push(basename(current)); current = dirname(current);
    }
  }
}
function leaf(value: string) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[/\\:\0]/.test(value)) throw new FileBoundaryFault('invalid_request', 'open');
  return value;
}
function privateFile(stat: BigIntStats) {
  return stat.isFile() && stat.uid === BigInt(process.getuid!()) && (stat.mode & 0o077n) === 0n;
}

class PosixMutationScope implements HostFileMutationScope {
  readonly #files: HostMetadataFiles;
  readonly #requestedRoot: string;
  readonly #root: string;
  readonly #forbidden: readonly string[];
  readonly #anchors: Entry[] = [];
  readonly #directories = new Map<string, Entry>();
  #references = new WeakMap<MetadataDirectory, Entry>();
  #closed = false;
  constructor(options: { root: string; forbiddenRoots: readonly string[] }) {
    this.#files = hostMetadataFiles(); this.#requestedRoot = validPath(options.root);
    if (dirname(this.#requestedRoot) === this.#requestedRoot || !Array.isArray(options.forbiddenRoots)) throw new FileBoundaryFault('invalid_request', 'directory');
    this.#forbidden = Object.freeze(options.forbiddenRoots.map(validPath));
    const parent = realpathSync(dirname(this.#requestedRoot)); this.#root = join(parent, basename(this.#requestedRoot));
    this.#checkForbidden();
    const chain: string[] = []; for (let path = parent; ; path = dirname(path)) { chain.push(path); if (dirname(path) === path) break; }
    for (const path of chain.reverse()) {
      const access = path === parent ? 'sync' : 'traverse'; const reference = this.#files.inspectDirectory(path, access);
      if (!reference) throw new FileBoundaryFault('missing', 'directory');
      this.#anchors.push({ path, access, reference });
    }
    const existing = this.#files.inspectDirectory(this.#root, 'owner-writable');
    if (existing) this.#remember(this.#root, 'owner-writable', existing);
    this.#guard(this.#root);
  }
  #checkForbidden() {
    const actual = canonical(this.#root);
    for (const forbidden of this.#forbidden) {
      const protectedPath = canonical(forbidden);
      if (inside(protectedPath, actual) || inside(actual, protectedPath)) throw new FileBoundaryFault('unsafe', 'directory');
    }
  }
  #alive() { if (this.#closed) throw new FileBoundaryFault('invalid_request', 'directory'); }
  #path(path: string) {
    const absolute = validPath(path);
    const target = inside(this.#requestedRoot, absolute) ? join(this.#root, relative(this.#requestedRoot, absolute)) : absolute;
    if (!inside(this.#root, target)) throw new FileBoundaryFault('invalid_request', 'directory');
    return target;
  }
  #inspect(entry: Entry) {
    const current = this.#files.inspectDirectory(entry.path, entry.access, entry.reference);
    if (!current) throw new FileBoundaryFault('changed', 'directory');
  }
  #guard(path: string) {
    this.#alive(); this.#checkForbidden();
    for (const entry of this.#anchors) this.#inspect(entry);
    for (const entry of this.#directories.values()) if (inside(entry.path, path)) this.#inspect(entry);
  }
  #remember(path: string, access: MetadataAccess, reference: MetadataDirectory): Entry {
    const entry = { path, access, reference }; this.#directories.set(path, entry); this.#references.set(reference, entry); return entry;
  }
  #parent(path: string): Entry {
    const parent = dirname(path);
    if (path === this.#root) return this.#anchors[this.#anchors.length - 1]!;
    const existing = this.#directories.get(parent); if (existing) return existing;
    this.#parent(parent);
    const reference = this.#files.inspectDirectory(parent, 'owner-writable');
    if (!reference) throw Object.assign(new Error('mutation parent does not exist'), { code: 'ENOENT', path: parent, syscall: 'lstat' });
    return this.#remember(parent, 'owner-writable', reference);
  }
  check() {
    this.#guard(this.#root);
    for (const entry of this.#directories.values()) this.#inspect(entry);
  }
  directory(path: string, access: MetadataAccess, create = false, exclusive = false): MetadataDirectory | null {
    this.#alive(); if (!['private', 'owner-writable'].includes(access) || typeof create !== 'boolean' || typeof exclusive !== 'boolean' || exclusive && !create) throw new FileBoundaryFault('invalid_request', 'directory');
    const target = this.#path(path); this.#guard(target); const parent = this.#parent(target); this.#guard(parent.path);
    const previous = this.#directories.get(target); const effective = previous?.access === 'private' ? 'private' : access;
    if (!create) {
      const current = this.#files.inspectDirectory(target, effective, previous?.reference);
      if (!current) return null;
      if (previous && effective === previous.access) return previous.reference;
      return this.#remember(target, effective, current).reference;
    }
    const progress = { ...status() }; const errors: FileMutationFailure[] = []; let reference: MetadataDirectory | undefined;
    if (!previous || exclusive) {
      try { mkdirSync(target, { mode: 0o700 }); progress.created = true; }
      catch (error) {
        if (errno(error) !== 'EEXIST' || exclusive) {
          if (creationRejected.has(errno(error) ?? '')) throw error;
          progress.created = 'unknown'; errors.push({ stage: 'directory_create', error });
        }
      }
    }
    if (!errors.length) try {
      const current = this.#files.inspectDirectory(target, effective, previous?.reference);
      if (!current) throw Object.assign(new Error('created directory is unavailable'), { code: 'ENOENT', path: target, syscall: 'lstat' });
      reference = previous && effective === previous.access ? previous.reference : this.#remember(target, effective, current).reference;
    } catch (error) { errors.push({ stage: 'inspect', error }); }
    try { this.#guard(parent.path); this.#files.syncDirectory(parent.reference); progress.directorySynced = true; }
    catch (error) { errors.push({ stage: 'directory_sync', error }); }
    try { this.#guard(target); } catch (error) { errors.push({ stage: 'check', error }); }
    if (errors.length) throw new FileMutationFault('directory', errors[0]!.stage, progress, errors);
    return reference!;
  }
  publish(directory: MetadataDirectory, name: string, input: Uint8Array, options: { executable?: boolean } = {}): FilePublicationResult {
    this.#alive(); const entry = this.#references.get(directory);
    if (!entry || !(input instanceof Uint8Array) || options.executable !== undefined && typeof options.executable !== 'boolean') throw new FileBoundaryFault('invalid_request', 'open');
    const file = leaf(name); this.#guard(entry.path); this.#inspect(entry);
    const bytes = Buffer.from(input); let candidateName = `.secumon-init-${randomUUID()}.pending`;
    for (let retry = 0; candidateName === file && retry < 8; retry++) candidateName = `.secumon-init-${randomUUID()}.pending`;
    if (candidateName === file) throw new FileBoundaryFault('invalid_request', 'open');
    const candidate = join(entry.path, candidateName); const target = join(entry.path, file);
    const progress = { ...status() }; const errors: FileMutationFailure[] = [];
    let fd: number | undefined; let captured: BigIntStats | undefined; let synced: BigIntStats | undefined; let stage = 'candidate_open';
    const owned = (path: string, exact = false) => {
      this.#guard(entry.path); const current = lstatSync(path, { bigint: true });
      if (!captured || !privateFile(current) || !sameFileIdentity(fileIdentity(current), fileIdentity(captured)) ||
        current.nlink < 1n || current.nlink > 2n || exact && (!synced || fileToken(current) !== fileToken(synced))) throw new FileBoundaryFault('changed', 'read');
      return current;
    };
    try {
      fd = openSync(candidate, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, options.executable ? 0o700 : 0o600);
      progress.created = true; progress.cleanup = 'retained'; stage = 'candidate_identity';
      captured = fstatSync(fd, { bigint: true });
      if (!privateFile(captured) || captured.nlink !== 1n) throw new FileBoundaryFault('unsafe', 'read');
      stage = 'candidate_write'; writeFileSync(fd, bytes);
      stage = 'file_sync'; fsyncSync(fd); progress.fileSynced = true;
      stage = 'candidate_verify'; synced = fstatSync(fd, { bigint: true });
      if (!privateFile(synced) || !sameFileIdentity(fileIdentity(synced), fileIdentity(captured)) || synced.nlink !== 1n || synced.size !== BigInt(bytes.length)) throw new FileBoundaryFault('changed', 'read');
    } catch (error) { errors.push({ stage, error }); }
    finally {
      if (fd !== undefined) try { closeSync(fd); } catch (error) { errors.push({ stage: 'candidate_close', error }); }
    }
    if (!errors.length) {
      try {
        stage = 'before_publish'; owned(candidate, true);
        stage = 'publish'; progress.publication = 'unknown';
        try { linkSync(candidate, target); progress.publication = 'published'; }
        catch (error) {
          let same = false;
          try { this.#guard(entry.path); const existing = lstatSync(target, { bigint: true }); same = !!captured && privateFile(existing) && sameFileIdentity(fileIdentity(existing), fileIdentity(captured)); }
          catch (observationError) { if (errno(observationError) !== 'ENOENT') errors.push({ stage: 'publication_observation', error: observationError }); }
          if (same) { progress.publication = 'published'; throw error; }
          if (errno(error) === 'EEXIST') progress.publication = 'not_published'; else throw error;
        }
      } catch (error) { errors.unshift({ stage, error }); }
    }
    if (progress.created) {
      try {
        if (!captured) throw new FileBoundaryFault('changed', 'read');
        owned(candidate); unlinkSync(candidate); progress.cleanup = 'removed';
      } catch (error) { errors.push({ stage: 'candidate_cleanup', error }); }
    }
    try { this.#guard(entry.path); this.#files.syncDirectory(entry.reference); progress.directorySynced = true; }
    catch (error) { errors.push({ stage: 'directory_sync', error }); }
    if (progress.publication === 'published') {
      try {
        owned(target);
        const actual = this.#files.readStableRegularFile(entry.reference, file, { maximum: bytes.length, access: 'private', allowLinkedFile: (record, siblings) => {
          const pending = siblings.inspect(candidateName);
          return record.links === 2n && pending?.links === 2n && sameFileIdentity(record.identity, pending.identity) && !!captured && sameFileIdentity(record.identity, fileIdentity(captured));
        } });
        if (!actual.equals(bytes)) throw new FileBoundaryFault('changed', 'read');
        owned(target);
      } catch (error) { errors.push({ stage: 'publication_check', error }); }
    }
    try { this.#guard(entry.path); } catch (error) { errors.push({ stage: 'check', error }); }
    if (errors.length) throw new FileMutationFault('publish', errors[0]!.stage, progress, errors);
    return Object.freeze({ ...progress, published: progress.publication === 'published' });
  }
  close() { this.#closed = true; this.#directories.clear(); this.#references = new WeakMap(); }
}

export class PosixFileMutations implements HostFileMutations {
  constructor() { hostMetadataFiles(); }
  openScope(options: { root: string; forbiddenRoots: readonly string[] }): HostFileMutationScope { return new PosixMutationScope(options); }
}
