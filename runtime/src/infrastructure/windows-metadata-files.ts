import { win32 } from 'node:path';
import { FileBoundaryFault, sameFileIdentity, type DirectoryAccess, type HostMetadataFiles, type MetadataDirectory,
  type MetadataFileMetrics, type MetadataReadPolicy, type MetadataSyncObserver } from './host-metadata-files.js';
import { loadWindowsFileAddon, windowsFileFault, type WindowsDirectoryHandle, type WindowsFileAddon } from './windows-file-addon.js';

type Entry = { path: string; access: DirectoryAccess; native: WindowsDirectoryHandle };
export function windowsAbsolutePath(path: string): string {
  if (typeof path !== 'string' || !/^[a-z]:\\/i.test(path) || path.includes('\0') || path.includes('/') || path.length > 4096)
    throw new FileBoundaryFault('invalid_request', 'directory');
  const components = path.slice(3).split('\\');
  if (path.length > 3 && components.some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)))
    throw new FileBoundaryFault('invalid_request', 'directory');
  // Native validation also rejects reserved device names before opening anything.
  return path;
}
function identity(value: string) {
  const match = /^([0-9a-f]{8}):([0-9a-f]{16})$/.exec(value);
  if (!match) throw new FileBoundaryFault('io', 'directory', new Error('windows_file_identity_invalid'));
  return Object.freeze({ volume: match[1]!, object: match[2]! });
}
/** Actual Win32 handles/ACLs. Private is intentionally stricter than owner-writable, and linked files are refused. */
export class WindowsMetadataFiles implements HostMetadataFiles {
  readonly capabilities = Object.freeze({ platform: 'win32', accessControl: 'windows-acl', objectAccess: 'handle-reference',
    directorySync: 'unsupported', nativeWindows: 'implemented' } as const);
  readonly #addon: WindowsFileAddon;
  readonly #directories = new WeakMap<MetadataDirectory, Entry>();
  constructor(addonPath?: string) { this.#addon = loadWindowsFileAddon(addonPath); }
  diagnostics(): Readonly<MetadataFileMetrics> { return Object.freeze({ ...this.#addon.fileMetrics() }); }
  /** Host-only reference issuance also used by mutation scopes; native objects retain their ancestor handles. */
  reference(native: WindowsDirectoryHandle, path: string, access: DirectoryAccess): MetadataDirectory {
    try {
      const info = native.check();
      if ((access === 'private' || access === 'owner-writable') && !info.private) throw new FileBoundaryFault('unsafe', 'directory');
      const reference = Object.freeze({ identity: identity(info.identity) });
      this.#directories.set(reference, { path, access, native }); return reference;
    } catch (error) {
      const failures: unknown[] = [error];
      try { failures.push(...native.close().map(message => new Error(message))); } catch (close) { failures.push(close); }
      if (failures.length > 1) throw new FileBoundaryFault('io', 'directory', new AggregateError(failures, 'windows_reference_open_failed'));
      throw windowsFileFault(error, 'directory');
    }
  }
  handle(directory: MetadataDirectory): WindowsDirectoryHandle {
    const entry = this.#directories.get(directory); if (!entry) throw new FileBoundaryFault('invalid_request', 'directory');
    try {
      const info = entry.native.check();
      if (!sameFileIdentity(directory.identity, identity(info.identity))) throw new FileBoundaryFault('changed', 'directory');
      return entry.native;
    } catch (error) { throw windowsFileFault(error, 'directory'); }
  }
  closeDirectory(directory: MetadataDirectory): void {
    const entry = this.#directories.get(directory); if (!entry) throw new FileBoundaryFault('invalid_request', 'directory');
    this.#directories.delete(directory);
    const errors = entry.native.close(); if (errors.length) throw new FileBoundaryFault('io', 'directory', new AggregateError(errors.map(message => new Error(message)), 'windows_handle_close_failed'));
  }
  inspectDirectory(path: string, access: DirectoryAccess, expected?: MetadataDirectory): MetadataDirectory | null {
    windowsAbsolutePath(path);
    if (!['private', 'owner-writable', 'traverse', 'sync'].includes(access)) throw new FileBoundaryFault('invalid_request', 'directory');
    if (expected) {
      const prior = this.#directories.get(expected);
      if (!prior || win32.normalize(prior.path).toUpperCase() !== win32.normalize(path).toUpperCase()) throw new FileBoundaryFault('invalid_request', 'directory');
      this.handle(expected);
    }
    try {
      const native = this.#addon.openDirectory(path, access === 'private' || access === 'owner-writable');
      if (!native) return null;
      const reference = this.reference(native, path, access);
      if (expected && !sameFileIdentity(expected.identity, reference.identity)) {
        this.closeDirectory(reference); throw new FileBoundaryFault('changed', 'directory');
      }
      if (expected) { this.closeDirectory(reference); return expected; }
      return reference;
    } catch (error) { throw windowsFileFault(error, 'directory'); }
  }
  names(directory: MetadataDirectory, maximum: number): string[] {
    if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 65536) throw new FileBoundaryFault('invalid_request', 'directory');
    try { return this.handle(directory).names(maximum); } catch (error) { throw windowsFileFault(error, 'directory'); }
  }
  inspectChild(directory: MetadataDirectory, name: string, privateAccess = true) {
    try { return this.handle(directory).inspectChild(name, privateAccess); } catch (error) { throw windowsFileFault(error, 'read'); }
  }
  readStableRegularFile(directory: MetadataDirectory, leaf: string, policy: MetadataReadPolicy): Buffer {
    const entry = this.#directories.get(directory);
    if (!entry || entry.access === 'sync' || !Number.isSafeInteger(policy.maximum) || policy.maximum < 0 ||
      !['private', 'owner-writable'].includes(policy.access)) throw new FileBoundaryFault('invalid_request', 'read');
    const native = this.handle(directory);
    // Reserve the two native regular-file metadata observations before entering synchronous I/O.
    policy.observer?.metadata(); policy.observer?.metadata();
    try {
      const bytes = native.readRegular(leaf, Math.min(policy.maximum, 4 * 1024 * 1024));
      policy.observer?.read(bytes.length); return Buffer.from(bytes);
    } catch (error) { throw windowsFileFault(error, 'read'); }
  }
  syncDirectory(directory: MetadataDirectory, _observer?: MetadataSyncObserver): never {
    this.handle(directory);
    throw new FileBoundaryFault('unsupported_platform', 'sync', new Error('namespace_durability_unsupported'));
  }
}
