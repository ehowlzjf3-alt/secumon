import { constants, closeSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { WorkspaceFile } from '../domain/workspace.js';
import type { WorkspaceStore } from '../application/workspace-checkpoints.js';
import { WorkspaceError } from '../application/workspace-checkpoints.js';
import { WorkspaceFileSchema, WorkspacePathSchema } from '../application/workspace-contracts.js';
import { parseContract } from '../application/contracts.js';
import { sha256 } from './digest.js';
import { storageRootParts } from './local-file-paths.js';
import { FileBoundaryFault, hostMetadataFiles, completeMetadataPublication, releaseMetadataDirectory, hostFileDurabilityPolicy, type HostMetadataFiles, type MetadataDirectory } from './host-metadata-files.js';
import { WindowsMetadataFiles } from './windows-metadata-files.js';
import { windowsProfilePath } from './windows-profile-files.js';
import { publishWindowsFileSync, readWindowsFile, windowsStreamLimits } from './windows-stream-files.js';

export interface FileWorkspaceOptions { maxFileBytes?: number; maxFilesPerAttempt?: number; maxAttemptBytes?: number }
const idSchema = z.string().min(1).max(256);
const recordSchema = z.strictObject({ schemaVersion: z.literal(1), file: WorkspaceFileSchema, contentBase64: z.string(), checksum: z.string().regex(/^[a-f0-9]{64}$/) });
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

export class FileWorkspaceStore implements WorkspaceStore {
  #root: string;
  readonly #files: HostMetadataFiles;
  readonly #parentDirectory: MetadataDirectory;
  #directories = new Map<string, MetadataDirectory>();
  #closed = false;
  readonly limits: { maxFileBytes: number; maxFilesPerAttempt: number; maxAttemptBytes: number };
  readonly durability = hostFileDurabilityPolicy();
  constructor(directory: string, options: FileWorkspaceOptions = {}) {
    try { this.#files = hostMetadataFiles(); }
    catch (error) { this.#boundaryFailure(error); }
    this.limits = Object.freeze({ maxFileBytes: 1048576, maxFilesPerAttempt: 128, maxAttemptBytes: 16777216, ...options });
    if (Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw new WorkspaceError('invalid_workspace_configuration');
    const parts = storageRootParts(directory);
    if (!parts) throw new WorkspaceError('workspace_root_invalid');
    const parent = process.platform === 'win32' ? windowsProfilePath(parts.parent) : realpathSync(parts.parent);
    this.#parentDirectory = this.#inspect(parent, undefined, 'sync');
    this.#root = join(parent, parts.name);
    try { const root = this.#directory(this.#root, true); this.#sync(root); this.#sync(this.#parentDirectory); }
    catch (error) {
      const errors: unknown[] = [error];
      for (const ref of [...this.#directories.values()].reverse().concat(this.#parentDirectory)) {
        try { releaseMetadataDirectory(this.#files, ref); } catch (close) { errors.push(close); }
      }
      this.#directories.clear(); if (errors.length > 1) throw new AggregateError(errors, 'workspace_open_failed'); throw error;
    }
  }
  #boundaryFailure(error: unknown): never {
    if (!(error instanceof FileBoundaryFault)) throw error;
    if (error.code === 'unsafe') throw new WorkspaceError('workspace_directory_unsafe', { cause: error });
    if (error.code === 'changed') throw new WorkspaceError('workspace_directory_changed', { cause: error });
    if (error.code === 'unsupported_platform') throw new WorkspaceError('workspace_platform_unsupported', { cause: error });
    if ((error.code === 'io' || error.code === 'missing') && error.cause !== undefined) throw error.cause;
    throw error;
  }
  #inspect(path: string, expected?: MetadataDirectory, access: 'private' | 'sync' = 'private', lock = false): MetadataDirectory {
    try {
      const directory = this.#files.inspectDirectory(path, access, expected);
      if (directory) return directory;
      if (lock) throw new WorkspaceError('workspace_lock_lost');
      throw Object.assign(new Error('directory does not exist'), { code: 'ENOENT', syscall: 'lstat', path });
    } catch (error) { this.#boundaryFailure(error); }
  }
  #directory(path: string, create = false): MetadataDirectory {
    const expected = this.#directories.get(path);
    if (this.#files instanceof WindowsMetadataFiles && create && !expected) {
      const parent = this.#directories.get(dirname(path)) ?? (path === this.#root ? this.#parentDirectory : undefined);
      if (!parent) throw new WorkspaceError('workspace_directory_unsafe');
      const native = this.#files.handle(parent).childDirectory(basename(path), true, false, 'process-crash');
      if (!native) throw new WorkspaceError('workspace_directory_unsafe');
      const directory = this.#files.reference(native, path, 'private'); this.#directories.set(path, directory); return directory;
    }
    if (create && !expected) { try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (errorCode(error) !== 'EEXIST') throw error; } }
    const directory = this.#inspect(path, expected);
    this.#directories.set(path, directory);
    return directory;
  }
  #sync(directory: MetadataDirectory) {
    try { completeMetadataPublication(this.#files, directory); }
    catch (error) { this.#boundaryFailure(error); }
  }
  #scope(workId: string, attemptId: string) {
    if (this.#closed) throw new WorkspaceError('workspace_store_closed');
    parseContract(idSchema, workId); parseContract(idSchema, attemptId); this.#directory(this.#root);
    const work = join(this.#root, sha256(workId)); this.#directory(work, true);
    const attempt = join(work, sha256(attemptId)); this.#directory(attempt, true);
    return { work, attempt };
  }
  #locked<T>(workId: string, attemptId: string, action: (folder: string) => T): T {
    if (this.#files instanceof WindowsMetadataFiles) return this.#lockedWindows(workId, attemptId, action, this.#files);
    const scope = this.#scope(workId, attemptId); const lock = join(scope.attempt, '.lock');
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch (error) { if (errorCode(error) === 'EEXIST') throw new WorkspaceError('workspace_busy'); throw error; }
    // A lock belongs to one invocation. A later invocation creates a new directory.
    const acquired = this.#inspect(lock, undefined, 'private', true);
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      this.#directory(this.#root); this.#directory(scope.work); this.#directory(scope.attempt);
      const folder = join(scope.attempt, 'files'); this.#directory(folder, true);
      this.#inspect(lock, acquired, 'private', true);
      const value = action(folder);
      const root = this.#directory(this.#root); const work = this.#directory(scope.work);
      const attempt = this.#directory(scope.attempt); const files = this.#directory(folder);
      this.#inspect(lock, acquired, 'private', true);
      this.#sync(files); this.#sync(attempt); this.#sync(work); this.#sync(root); this.#sync(this.#parentDirectory);
      this.#directory(this.#root); this.#directory(scope.work); this.#directory(scope.attempt); this.#directory(folder);
      this.#inspect(lock, acquired, 'private', true);
      outcome = { ok: true, value };
    } catch (error) { outcome = { ok: false, error }; }
    try {
      // Do not remove a lock reached through a substituted ancestor.
      this.#directory(this.#root); this.#directory(scope.work);
      const attempt = this.#directory(scope.attempt);
      this.#inspect(lock, acquired, 'private', true);
      rmdirSync(lock); this.#sync(attempt);
      if (outcome.ok) {
        this.#directory(this.#root); this.#directory(scope.work); this.#directory(scope.attempt); this.#directory(join(scope.attempt, 'files'));
      }
    } catch (cleanupError) {
      if (outcome.ok) throw cleanupError;
      const code = errorCode(outcome.error);
      throw new WorkspaceError(typeof code === 'string' ? code : 'workspace_operation_failed', { cause: outcome.error, cleanupError });
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
  #lockedWindows<T>(workId: string, attemptId: string, action: (folder: string) => T, files: WindowsMetadataFiles): T {
    const scope = this.#scope(workId, attemptId), attempt = this.#directory(scope.attempt);
    let lock;
    try { lock = files.handle(attempt).lockRegular('.lock'); }
    catch (error) {
      if (error instanceof Error && /windows_file:[^:]+:[^:]+:(32|80|183)\b/.test(error.message)) throw new WorkspaceError('workspace_busy', { cause: error });
      throw error;
    }
    let primary: { error: unknown } | undefined;
    try {
      lock.check(); const folder = join(scope.attempt, 'files'); this.#directory(folder, true);
      const result = action(folder);
      for (const path of [folder, scope.attempt, scope.work, this.#root]) this.#sync(this.#directory(path));
      this.#sync(this.#parentDirectory); lock.check(); return result;
    } catch (error) { primary = { error }; throw error; }
    finally { try { lock.close(); } catch (error) { if (primary) throw new AggregateError([primary.error, error], 'workspace_lock_close_failed'); throw error; } }
  }
  #serialized(folder: string, name: string, kind: 'read' | 'list'): Buffer {
    const directory = this.#directories.get(folder);
    if (!directory) throw new FileBoundaryFault('invalid_request', 'directory');
    let opened = false;
    try {
      if (this.#files instanceof WindowsMetadataFiles) {
        const exists = this.#files.inspectChild(directory, name); opened = exists !== null;
        return readWindowsFile(this.#files, directory, name, Math.ceil(this.limits.maxFileBytes * 4 / 3) + 65536);
      }
      return this.#files.readStableRegularFile(directory, name, {
        maximum: Math.ceil(this.limits.maxFileBytes * 4 / 3) + 65536, access: 'private',
        // Preserve the workspace's existing hardlink policy. This is not supplied by tools or models.
        allowLinkedFile: () => true,
        // Distinguish an initial absent file from disappearance before a retry opens it again.
        observer: { metadata: () => { opened = true; }, read: () => {} },
      });
    } catch (error) {
      if (!(error instanceof FileBoundaryFault)) throw error;
      if (error.operation === 'directory' || error.code === 'unsupported_platform') this.#boundaryFailure(error);
      if (error.code === 'invalid_request') throw error;
      if (error.code === 'changed' || error.code === 'missing' && opened) throw new WorkspaceError('workspace_file_changed', { cause: error });
      if (error.operation === 'open') throw new WorkspaceError(error.code === 'missing' && kind === 'read' ? 'workspace_file_unavailable' : 'workspace_file_unsafe', { cause: error.cause ?? error });
      if (error.code === 'unsafe') throw new WorkspaceError('workspace_file_unsafe', { cause: error });
      if (error.code === 'too_large') throw new WorkspaceError(kind === 'list' ? 'workspace_file_unsafe' : 'workspace_file_too_large', { cause: error });
      if (error.code === 'io' && error.cause !== undefined) throw error.cause;
      throw error;
    }
  }
  #record(folder: string, workId: string, attemptId: string, name: string, requestedPath?: string) {
    const serialized = this.#serialized(folder, name, requestedPath === undefined ? 'list' : 'read');
    let record;
    try { record = parseContract(recordSchema, JSON.parse(serialized.toString('utf8'))); }
    catch { throw new WorkspaceError('workspace_file_integrity_failure'); }
    if (requestedPath === undefined && sha256(record.file.path) + '.json' !== name) throw new WorkspaceError('workspace_file_identity_mismatch');
    const { checksum, ...payload } = record; const bytes = Buffer.from(record.contentBase64, 'base64');
    if (sha256(JSON.stringify(payload)) !== checksum || bytes.toString('base64') !== record.contentBase64 || bytes.byteLength !== record.file.byteLength || sha256(bytes) !== record.file.sha256) throw new WorkspaceError('workspace_file_integrity_failure');
    if (record.file.workId !== workId || record.file.attemptId !== attemptId || requestedPath !== undefined && record.file.path !== requestedPath) throw new WorkspaceError('workspace_file_identity_mismatch');
    if (bytes.length > this.limits.maxFileBytes) throw new WorkspaceError('workspace_file_too_large');
    return { file: record.file, bytes };
  }
  #read(folder: string, workId: string, attemptId: string, path: string) {
    return this.#record(folder, workId, attemptId, sha256(path) + '.json', path);
  }
  #list(folder: string, workId: string, attemptId: string): WorkspaceFile[] {
    const names = this.#files instanceof WindowsMetadataFiles ? this.#files.names(this.#directory(folder), Math.min(65536, this.limits.maxFilesPerAttempt + 1)) : readdirSync(folder).sort(); const files: WorkspaceFile[] = [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new WorkspaceError(name.endsWith('.pending') ? 'workspace_incomplete_write' : 'workspace_layout_invalid');
      files.push(this.#record(folder, workId, attemptId, name).file);
    }
    return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  }
  async stage(workId: string, attemptId: string, path: string, bytes: Uint8Array, attributes: Pick<WorkspaceFile, 'tenantId' | 'labels' | 'lifecycleGeneration'>): Promise<WorkspaceFile> {
    path = parseContract(WorkspacePathSchema, path); const content = Buffer.from(bytes);
    if (content.length > this.limits.maxFileBytes) throw new WorkspaceError('workspace_file_too_large');
    const file = parseContract(WorkspaceFileSchema, { workId, attemptId, path, ...attributes, labels: [...new Set(attributes.labels)].sort(), byteLength: content.length, sha256: sha256(content) });
    return this.#locked(workId, attemptId, folder => {
      const files = this.#list(folder, workId, attemptId); const existing = files.find(value => value.path === path);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(file)) throw new WorkspaceError('workspace_file_conflict');
        return structuredClone(existing);
      }
      if (files.length >= this.limits.maxFilesPerAttempt || files.reduce((total, value) => total + value.byteLength, 0) + file.byteLength > this.limits.maxAttemptBytes) throw new WorkspaceError('workspace_capacity_exceeded');
      const payload = { schemaVersion: 1, file, contentBase64: content.toString('base64') };
      const serialized = Buffer.from(JSON.stringify({ ...payload, checksum: sha256(JSON.stringify(payload)) }));
      if (serialized.length > Math.ceil(this.limits.maxFileBytes * 4 / 3) + 65536) throw new WorkspaceError('workspace_file_too_large');
      if (this.#files instanceof WindowsMetadataFiles) {
        if (serialized.length > windowsStreamLimits.fileBytes) throw new WorkspaceError('workspace_file_too_large');
        const result = publishWindowsFileSync(this.#files, this.#directory(folder), `${sha256(path)}.json`, serialized);
        if (!result.published) {
          if (JSON.stringify(this.#read(folder, workId, attemptId, path).file) !== JSON.stringify(file)) throw new WorkspaceError('workspace_file_conflict');
        }
        return structuredClone(file);
      }
      const candidate = join(folder, `${randomUUID()}.pending`); const fd = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, serialized); fsyncSync(fd); }
      finally { closeSync(fd); }
      try { linkSync(candidate, join(folder, `${sha256(path)}.json`)); }
      catch (error) { if (errorCode(error) === 'EEXIST') throw new WorkspaceError('workspace_file_conflict'); throw error; }
      finally { unlinkSync(candidate); }
      return structuredClone(file);
    });
  }
  async read(workId: string, attemptId: string, path: string) {
    path = parseContract(WorkspacePathSchema, path);
    return this.#locked(workId, attemptId, folder => { const stored = this.#read(folder, workId, attemptId, path); return { file: structuredClone(stored.file), bytes: new Uint8Array(stored.bytes) }; });
  }
  async list(workId: string, attemptId: string) { return this.#locked(workId, attemptId, folder => structuredClone(this.#list(folder, workId, attemptId))); }
  async removeAttempt(workId: string, attemptId: string, expectedFiles: WorkspaceFile[]) {
    const expected = expectedFiles.map(file => parseContract(WorkspaceFileSchema, file)).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    this.#locked(workId, attemptId, folder => {
      const current = this.#list(folder, workId, attemptId);
      if (JSON.stringify(current) !== JSON.stringify(expected)) throw new WorkspaceError('workspace_manifest_changed');
      for (const file of current) {
        const name = `${sha256(file.path)}.json`;
        if (this.#files instanceof WindowsMetadataFiles) {
          const bytes = this.#serialized(folder, name, 'list');
          if (!this.#files.handle(this.#directory(folder)).removeRegular(name, bytes)) throw new WorkspaceError('workspace_manifest_changed');
        } else unlinkSync(join(folder, name));
      }
    });
  }
  async close() {
    if (this.#closed) return; this.#closed = true; const errors: unknown[] = [];
    for (const ref of [...this.#directories.values()].reverse().concat(this.#parentDirectory)) {
      try { releaseMetadataDirectory(this.#files, ref); } catch (error) { errors.push(error); }
    }
    this.#directories.clear(); if (errors.length) throw new AggregateError(errors, 'workspace_close_failed');
  }
}
