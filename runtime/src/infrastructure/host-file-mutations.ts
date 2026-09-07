import type { MetadataAccess, MetadataDirectory } from './host-metadata-files.js';
import { FileBoundaryFault, hostFileDurabilityPolicy } from './host-metadata-files.js';
import { PosixFileMutations } from './posix-file-mutations.js';
import { WindowsFileMutations } from './windows-file-mutations.js';

export type FilePublication = 'not_published' | 'published' | 'unknown';
export interface FileMutationStatus {
  readonly publication: FilePublication;
  readonly created: boolean | 'unknown';
  readonly fileSynced: boolean;
  readonly directorySynced: boolean;
  readonly cleanup: 'not_needed' | 'removed' | 'retained' | 'unknown';
}
export interface FileMutationFailure { readonly stage: string; readonly error: unknown }
export class FileMutationFault extends Error {
  readonly code = 'file_mutation_failed';
  readonly status: Readonly<FileMutationStatus>;
  readonly errors: readonly FileMutationFailure[];
  constructor(readonly operation: 'directory' | 'publish', readonly stage: string, status: FileMutationStatus, errors: readonly FileMutationFailure[]) {
    super(`file_mutation_${operation}_${stage}`, errors.length ? { cause: errors[0]!.error } : undefined);
    this.status = Object.freeze({ ...status });
    this.errors = Object.freeze(errors.map(failure => Object.freeze({ ...failure })));
  }
}
export interface FilePublicationResult extends FileMutationStatus { readonly published: boolean }
export interface HostFileMutationScope {
  directory(path: string, access: MetadataAccess, create?: boolean, exclusive?: boolean): MetadataDirectory | null;
  publish(directory: MetadataDirectory, leaf: string, bytes: Uint8Array, options?: { executable?: boolean }): FilePublicationResult;
  check(): void;
  close(): void;
}
export interface HostFileMutations {
  openScope(options: { root: string; forbiddenRoots: readonly string[] }): HostFileMutationScope;
}
let local: HostFileMutations | undefined;
export function hostFileMutations(platform: NodeJS.Platform = process.platform): HostFileMutations {
  if (platform !== process.platform || !['linux', 'darwin', 'win32'].includes(platform)) throw new FileBoundaryFault('unsupported_platform', 'directory');
  return local ??= platform === 'win32' ? new WindowsFileMutations({ durability: hostFileDurabilityPolicy() === 'process-crash' ? 'process-crash' : 'strict-namespace' }) : new PosixFileMutations();
}
