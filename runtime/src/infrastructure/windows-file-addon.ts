import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileBoundaryFault, type MetadataFileMetrics } from './host-metadata-files.js';

export type WindowsDurability = 'strict-namespace' | 'process-crash';
export interface WindowsDirectoryInfo { identity: string; path: string; private: boolean; created: boolean; changeToken: string }
export interface WindowsPathInfo { identity: string; kind: 'regular' | 'directory'; bytes: string; changeToken: string }
export interface WindowsPublication {
  ok: boolean; publication: 'not_attempted' | 'not_published' | 'created' | 'already_exists' | 'unknown';
  fileFlush: string; namespaceBarrier: 'unsupported'; cleanup: string; code?: string; phase: string;
  win32Error?: number; cleanupWin32Error?: number; closeWin32Error?: number; candidateName?: string; fileIdentity?: string;
}
export interface WindowsDirectoryHandle {
  check(): WindowsDirectoryInfo;
  names(maximum: number): string[];
  inspectChild(leaf: string, privateAccess: boolean): WindowsPathInfo | null;
  readRegular(leaf: string, maximum: number): Buffer;
  childDirectory(leaf: string, create: boolean, exclusive: boolean, durability: WindowsDurability): WindowsDirectoryHandle | null;
  publish(leaf: string, bytes: Buffer, durability: WindowsDurability): WindowsPublication;
  openReadRegular(leaf: string, maximum: number): WindowsReadStream;
  createCandidate(leaf: string, maximum: number, durability: WindowsDurability): WindowsWriteCandidate;
  recoverableCandidate(leaf: string, candidate: string, maximum: number, expected: WindowsPathInfo | null, durability: WindowsDurability): WindowsWriteCandidate;
  moveRegular(leaf: string, target: string, expectedBytes: Buffer): boolean;
  syncRegular(leaf: string, expected: WindowsPathInfo): void;
  publishExisting(leaf: string, target: WindowsDirectoryHandle, targetLeaf: string, expected: WindowsPathInfo): WindowsPublication;
  database(leaf: string, create: boolean): WindowsDatabaseGuard | null;
  removeRegular(leaf: string, expectedBytes: Buffer): boolean;
  lockRegular(leaf: string): WindowsFileLock;
  close(): string[];
}
export interface WindowsReadStream { info(): WindowsPathInfo; read(maximum: number): Buffer; close(): void }
export interface WindowsWriteCandidate { append(bytes: Buffer): void; prepare(): void; publish(): WindowsPublication; close(): void }
export interface WindowsDatabaseGuard { path(): string; info(): WindowsPathInfo; check(): void; close(): void }
export interface WindowsFileLock { check(): void; close(): void }
export interface WindowsFileAddon {
  setupCapabilities(): { win32BackendCompiled: boolean; hostFilesApiVersion: number; namespaceBarrier: string; maximumBytes: number; maximumStreamBytes: number };
  openDirectory(path: string, privateAccess: boolean): WindowsDirectoryHandle | null;
  fileMetrics(): MetadataFileMetrics;
}
const require = createRequire(import.meta.url);
/** A binary installed by the host, never a library path supplied by a model or environment variable. */
export function loadWindowsFileAddon(path = fileURLToPath(new URL('../../native/windows-files/secumon_windows_files.node', import.meta.url))): WindowsFileAddon {
  if (process.platform !== 'win32' || !isAbsolute(path)) throw new FileBoundaryFault('unsupported_platform', 'directory');
  try {
    const addon = require(path) as WindowsFileAddon;
    const capability = addon.setupCapabilities();
    if (capability.win32BackendCompiled !== true || capability.hostFilesApiVersion !== 4 || capability.maximumStreamBytes !== 1024 ** 3 || capability.namespaceBarrier !== 'unsupported' ||
      capability.maximumBytes !== 4 * 1024 * 1024 || typeof addon.openDirectory !== 'function' || typeof addon.fileMetrics !== 'function')
      throw new Error('windows_file_addon_contract_invalid');
    return addon;
  } catch (cause) { throw new FileBoundaryFault('unsupported_platform', 'directory', cause); }
}
export function windowsFileFault(error: unknown, operation: FileBoundaryFault['operation']): FileBoundaryFault {
  if (error instanceof FileBoundaryFault) return error;
  const match = error instanceof Error ? /windows_file:([^:]+):([^:]+):(\d+)/.exec(error.message) : null;
  const code = match?.[1], win32 = Number(match?.[3]);
  const selected = (code === 'file_too_large' || code === 'directory_too_large') ? 'too_large' : code?.includes('changed') ? 'changed' :
    code === 'unsupported_platform' || code === 'namespace_durability_unsupported' ? 'unsupported_platform' :
    code === 'closed_reference' || code === 'invalid_request' || code === 'unsafe_name' || code === 'local_absolute_path_required' || code === 'path_too_deep' ? 'invalid_request' :
    code === 'unsafe_object' || code === 'local_ntfs_required' || code === 'volume_root_required' ? 'unsafe' : win32 === 2 || win32 === 3 ? 'missing' : 'io';
  return new FileBoundaryFault(selected, operation, error);
}
