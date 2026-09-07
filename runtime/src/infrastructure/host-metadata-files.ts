import { PosixMetadataFiles } from './posix-metadata-files.js';
import { WindowsMetadataFiles } from './windows-metadata-files.js';

export type MetadataAccess = 'private' | 'owner-writable';
export type DirectoryAccess = MetadataAccess | 'traverse' | 'sync';
export interface FileIdentity { readonly volume: string; readonly object: string }
export interface MetadataSnapshot {
  readonly identity: FileIdentity;
  readonly kind: 'regular' | 'directory' | 'link' | 'other';
  readonly ownedByCaller: boolean;
  readonly private: boolean;
  readonly ownerWritableOnly: boolean;
  readonly links: bigint;
  readonly size: bigint;
  /** Host-specific full metadata change token; callers may compare, not interpret it. */
  readonly changeToken: string;
}
/** Issued by one host adapter. An object copied or fabricated by a caller is not a valid reference. */
export interface MetadataDirectory { readonly identity: FileIdentity }
export type FileBoundaryCode = 'unsafe' | 'changed' | 'too_large' | 'missing' | 'io' | 'invalid_request' | 'unsupported_platform';
export class FileBoundaryFault extends Error {
  constructor(readonly code: FileBoundaryCode, readonly operation: 'directory' | 'open' | 'read' | 'sync', cause?: unknown) {
    super(`metadata_${operation}_${code}`, cause === undefined ? undefined : { cause });
  }
}
export interface MetadataObserver { metadata(): void; read(bytes: number): void }
/** Synchronous host observation immediately before a directory sync attempt. */
export interface MetadataSyncObserver { beforeSync(): void }
export interface MetadataSiblings {
  inspect(name: string): MetadataSnapshot | null;
  names(): Iterable<string>;
}
export interface MetadataReadPolicy {
  readonly maximum: number;
  readonly access: MetadataAccess;
  /** Host-owned storage policy; invoked only for multiple links, never supplied by tools or models. */
  readonly allowLinkedFile?: (file: MetadataSnapshot, siblings: MetadataSiblings) => boolean;
  readonly observer?: MetadataObserver;
}
export interface MetadataFileMetrics {
  directoryChecks: number; fileStats: number; fileOpens: number; fileCloses: number;
  dataReads: number; dataBytes: number; siblingLists: number; siblingEntries: number; directorySyncs: number;
}
export interface HostMetadataFiles {
  readonly capabilities: Readonly<{
    platform: 'linux' | 'darwin' | 'win32'; accessControl: 'posix-mode-and-uid' | 'windows-acl';
    objectAccess: 'path-recheck' | 'handle-reference'; directorySync: 'fsync' | 'native-flush' | 'unsupported';
    nativeWindows: 'unimplemented' | 'implemented';
  }>;
  inspectDirectory(path: string, access: DirectoryAccess, expected?: MetadataDirectory): MetadataDirectory | null;
  readStableRegularFile(directory: MetadataDirectory, leafName: string, policy: MetadataReadPolicy): Buffer;
  syncDirectory(directory: MetadataDirectory, observer?: MetadataSyncObserver): void;
  /** Actual boundary I/O counters, separate from existing consumers' header counters. */
  diagnostics(): Readonly<MetadataFileMetrics>;
}
export function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean { return a.volume === b.volume && a.object === b.object; }
export function metadataFileAllowed(file: MetadataSnapshot, access: MetadataAccess): boolean {
  return file.kind === 'regular' && file.ownedByCaller && (access === 'private' ? file.private : file.ownerWritableOnly);
}
let local: HostMetadataFiles | undefined;
/** Host dispatch only. A caller cannot emulate Windows permission checks using the POSIX adapter. */
export function hostMetadataFiles(platform: NodeJS.Platform = process.platform): HostMetadataFiles {
  if (platform !== process.platform || !['linux', 'darwin', 'win32'].includes(platform)) throw new FileBoundaryFault('unsupported_platform', 'directory');
  return local ??= platform === 'win32' ? new WindowsMetadataFiles() : new PosixMetadataFiles();
}

/** Host-selected durability; never inferred from a model request or a failed fsync. */
export type MetadataPublicationBarrier = Readonly<{ durability: 'namespace-fsync' | 'process-crash'; directorySynced: boolean }>;
export function hostFileDurabilityPolicy(platform: NodeJS.Platform = process.platform): 'namespace-fsync' | 'process-crash' {
  if (platform !== process.platform || !['linux', 'darwin', 'win32'].includes(platform)) throw new FileBoundaryFault('unsupported_platform', 'sync');
  return platform === 'win32' ? 'process-crash' : 'namespace-fsync';
}
/** Opted-in consumers accept the host policy explicitly; raw syncDirectory remains a strict barrier. */
export function completeMetadataPublication(files: HostMetadataFiles, directory: MetadataDirectory, observer?: MetadataSyncObserver): MetadataPublicationBarrier {
  if (hostFileDurabilityPolicy() === 'process-crash') {
    if (!(files instanceof WindowsMetadataFiles) || files.capabilities.directorySync !== 'unsupported') throw new FileBoundaryFault('unsupported_platform', 'sync');
    files.handle(directory); return Object.freeze({ durability: 'process-crash', directorySynced: false });
  }
  files.syncDirectory(directory, observer); return Object.freeze({ durability: 'namespace-fsync', directorySynced: true });
}
export function releaseMetadataDirectory(files: HostMetadataFiles, directory: MetadataDirectory): void {
  if (files instanceof WindowsMetadataFiles) files.closeDirectory(directory);
}
