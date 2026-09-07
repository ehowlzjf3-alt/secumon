import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, opendirSync, readSync, type BigIntStats } from 'node:fs';
import { constants as bufferConstants } from 'node:buffer';
import { join, resolve } from 'node:path';
import { FileBoundaryFault, metadataFileAllowed, sameFileIdentity } from './host-metadata-files.js';
import type { DirectoryAccess, HostMetadataFiles, MetadataDirectory, MetadataFileMetrics, MetadataReadPolicy,
  MetadataSnapshot, MetadataSiblings, MetadataSyncObserver } from './host-metadata-files.js';

type DirectoryState = { readonly path: string; readonly access: DirectoryAccess; readonly snapshot: MetadataSnapshot };
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
function snapshot(stat: BigIntStats): MetadataSnapshot {
  return Object.freeze({ identity: Object.freeze({ volume: String(stat.dev), object: String(stat.ino) }),
    kind: stat.isFile() ? 'regular' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'link' : 'other',
    ownedByCaller: typeof process.getuid === 'function' && stat.uid === BigInt(process.getuid()),
    private: (stat.mode & 0o077n) === 0n, ownerWritableOnly: (stat.mode & 0o022n) === 0n,
    links: stat.nlink, size: stat.size,
    changeToken: [stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') });
}
const unchanged = (a: MetadataSnapshot, b: MetadataSnapshot) => sameFileIdentity(a.identity, b.identity) && a.changeToken === b.changeToken;
function leafName(value: string) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[/\\\0]/.test(value)) {
    throw new FileBoundaryFault('invalid_request', 'open');
  }
  return value;
}

/** Preserves Node POSIX file checks. References recheck paths; they do not own native directory handles. */
export class PosixMetadataFiles implements HostMetadataFiles {
  readonly capabilities: HostMetadataFiles['capabilities'];
  readonly #directories = new WeakMap<MetadataDirectory, DirectoryState>();
  readonly #metrics: MetadataFileMetrics = { directoryChecks: 0, fileStats: 0, fileOpens: 0, fileCloses: 0,
    dataReads: 0, dataBytes: 0, siblingLists: 0, siblingEntries: 0, directorySyncs: 0 };
  constructor() {
    if (process.platform !== 'linux' && process.platform !== 'darwin' || typeof process.getuid !== 'function') {
      throw new FileBoundaryFault('unsupported_platform', 'directory');
    }
    this.capabilities = Object.freeze({ platform: process.platform, accessControl: 'posix-mode-and-uid',
      objectAccess: 'path-recheck', directorySync: 'fsync', nativeWindows: 'unimplemented' });
  }
  diagnostics(): Readonly<MetadataFileMetrics> { return Object.freeze({ ...this.#metrics }); }
  #io<T>(operation: FileBoundaryFault['operation'], action: () => T): T {
    try { return action(); }
    catch (error) {
      if (error instanceof FileBoundaryFault) throw error;
      const code = errorCode(error);
      throw new FileBoundaryFault(code === 'ENOENT' ? 'missing' : code === 'ELOOP' ? 'unsafe' : 'io', operation, error);
    }
  }
  #statDirectory(path: string): MetadataSnapshot | null {
    this.#metrics.directoryChecks++;
    try { return snapshot(lstatSync(path, { bigint: true })); }
    catch (error) { if (errorCode(error) === 'ENOENT') return null; throw new FileBoundaryFault('io', 'directory', error); }
  }
  #directoryAllowed(value: MetadataSnapshot, access: DirectoryAccess) {
    return value.kind === 'directory' && (access === 'traverse' || access === 'sync' || value.ownedByCaller &&
      (access === 'private' ? value.private : value.ownerWritableOnly));
  }
  #state(directory: MetadataDirectory): DirectoryState {
    const state = this.#directories.get(directory);
    if (!state) throw new FileBoundaryFault('invalid_request', 'directory');
    return state;
  }
  #check(directory: MetadataDirectory): DirectoryState {
    const state = this.#state(directory); const current = this.#statDirectory(state.path);
    if (!current || !sameFileIdentity(state.snapshot.identity, current.identity)) throw new FileBoundaryFault('changed', 'directory');
    if (!this.#directoryAllowed(current, state.access)) throw new FileBoundaryFault('unsafe', 'directory');
    return state;
  }
  inspectDirectory(path: string, access: DirectoryAccess, expected?: MetadataDirectory): MetadataDirectory | null {
    if (typeof path !== 'string' || !path || path.includes('\0') || !['private', 'owner-writable', 'traverse', 'sync'].includes(access)) {
      throw new FileBoundaryFault('invalid_request', 'directory');
    }
    const absolute = resolve(path); const prior = expected === undefined ? undefined : this.#state(expected);
    if (prior && prior.path !== absolute) throw new FileBoundaryFault('changed', 'directory');
    const current = this.#statDirectory(absolute); if (!current) return null;
    if (!this.#directoryAllowed(current, access)) throw new FileBoundaryFault('unsafe', 'directory');
    if (prior && !sameFileIdentity(prior.snapshot.identity, current.identity)) throw new FileBoundaryFault('changed', 'directory');
    const ref: MetadataDirectory = Object.freeze({ identity: current.identity });
    this.#directories.set(ref, Object.freeze({ path: absolute, access, snapshot: current })); return ref;
  }
  #fileStat(operation: 'open' | 'read', action: () => BigIntStats): MetadataSnapshot {
    this.#metrics.fileStats++; return snapshot(this.#io(operation, action));
  }
  #siblings(directory: MetadataDirectory): MetadataSiblings {
    const self = this;
    return Object.freeze({
      inspect(name: string) {
        const leaf = leafName(name); const state = self.#check(directory);
        try { return self.#fileStat('read', () => lstatSync(join(state.path, leaf), { bigint: true })); }
        catch (error) { if (error instanceof FileBoundaryFault && error.code === 'missing') return null; throw error; }
      },
      *names() {
        const state = self.#check(directory); self.#metrics.siblingLists++;
        const handle = self.#io('read', () => opendirSync(state.path));
        try {
          for (let entry = self.#io('read', () => handle.readSync()); entry; entry = self.#io('read', () => handle.readSync())) {
            self.#metrics.siblingEntries++; yield entry.name;
          }
        } finally { self.#io('read', () => handle.closeSync()); }
      },
    });
  }
  readStableRegularFile(directory: MetadataDirectory, name: string, policy: MetadataReadPolicy): Buffer {
    const leaf = leafName(name); const { maximum, access, allowLinkedFile, observer } = policy;
    if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum >= bufferConstants.MAX_LENGTH || !['private', 'owner-writable'].includes(access)) {
      throw new FileBoundaryFault('invalid_request', 'read');
    }
    if (this.#state(directory).access === 'sync') throw new FileBoundaryFault('invalid_request', 'read');
    const siblings = this.#siblings(directory);
    for (let retry = 0; retry < 2; retry++) {
      const state = this.#check(directory); const path = join(state.path, leaf);
      const fd = this.#io('open', () => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
      this.#metrics.fileOpens++;
      try {
        observer?.metadata(); const before = this.#fileStat('read', () => fstatSync(fd, { bigint: true }));
        if (!metadataFileAllowed(before, access) || before.links !== 1n && !allowLinkedFile?.(before, siblings)) {
          observer?.metadata(); const afterLink = this.#fileStat('read', () => fstatSync(fd, { bigint: true }));
          if (metadataFileAllowed(afterLink, access) && afterLink.links === 1n && !unchanged(before, afterLink)) continue;
          throw new FileBoundaryFault('unsafe', 'read');
        }
        if (before.size < 0n || before.size > BigInt(maximum)) throw new FileBoundaryFault('too_large', 'read');
        const bytes = Buffer.alloc(Number(before.size) + 1); let length = 0;
        while (length < bytes.length) {
          this.#metrics.dataReads++;
          const size = this.#io('read', () => readSync(fd, bytes, length, bytes.length - length, null));
          if (!size) break; length += size; this.#metrics.dataBytes += size;
        }
        observer?.read(length);
        observer?.metadata(); const after = this.#fileStat('read', () => fstatSync(fd, { bigint: true }));
        observer?.metadata(); const named = this.#fileStat('read', () => lstatSync(path, { bigint: true }));
        if (!unchanged(before, after) || !unchanged(after, named) || BigInt(length) !== before.size) continue;
        this.#check(directory); return bytes.subarray(0, length);
      } finally { this.#io('read', () => closeSync(fd)); this.#metrics.fileCloses++; }
    }
    throw new FileBoundaryFault('changed', 'read');
  }
  syncDirectory(directory: MetadataDirectory, observer?: MetadataSyncObserver): void {
    const state = this.#check(directory);
    const fd = this.#io('sync', () => openSync(state.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    try {
      const opened = this.#fileStat('read', () => fstatSync(fd, { bigint: true }));
      if (!sameFileIdentity(opened.identity, state.snapshot.identity) || !this.#directoryAllowed(opened, state.access)) {
        throw new FileBoundaryFault('changed', 'sync');
      }
      observer?.beforeSync();
      this.#metrics.directorySyncs++; this.#io('sync', () => fsyncSync(fd)); this.#check(directory);
    } finally { this.#io('sync', () => closeSync(fd)); }
  }
}
