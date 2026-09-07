import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ArtifactStore } from '../application/ports.js';
import { ArtifactSchema, parseContract } from '../application/contracts.js';
import type { ArtifactRef, Policy } from '../domain/model.js';
import { sha256 } from './digest.js';
import { windowsProfileFiles } from './windows-profile-files.js';
import { openProfileMutationScope, profileDirectory, syncProfileDirectory } from './agent-profile-files.js';
import { FileBoundaryFault, hostFileDurabilityPolicy } from './host-metadata-files.js';
import { readWindowsFile, publishWindowsFile, windowsStreamLimits } from './windows-stream-files.js';

export interface FileArtifactMetrics {
  getCalls: number;
  existsCalls: number;
  putCalls: number;
  metadataReadOperations: number;
  metadataReadBytes: number;
  bodyReadOperations: number;
  bodyReadBytes: number;
  hashCalls: number;
  hashBytes: number;
  fileWrites: number;
  metadataWriteBytes: number;
  bodyWriteBytes: number;
  readFailures: number;
  verificationFailures: number;
  deniedReads: number;
  writeFailures: number;
}
const emptyMetrics = (): FileArtifactMetrics => ({ getCalls: 0, existsCalls: 0, putCalls: 0, metadataReadOperations: 0, metadataReadBytes: 0,
  bodyReadOperations: 0, bodyReadBytes: 0, hashCalls: 0, hashBytes: 0, fileWrites: 0, metadataWriteBytes: 0, bodyWriteBytes: 0,
  readFailures: 0, verificationFailures: 0, deniedReads: 0, writeFailures: 0 });
type FilePart = 'metadata' | 'body';

export class FileArtifactStore implements ArtifactStore {
  #root: string;
  #metrics = emptyMetrics();
  readonly durability = hostFileDurabilityPolicy();
  constructor(root: string) { this.#root = resolve(root); }
  /** Host read/publication counters, not kernel syscalls or physical disk activity. Bytes count completed calls; failed partial I/O is unknown. */
  metrics(): Readonly<FileArtifactMetrics> { return Object.freeze({ ...this.#metrics }); }
  /** Reset at a quiescent boundary when comparing whole operations; in-flight completions are counted when they occur. */
  resetMetrics(): void { this.#metrics = emptyMetrics(); }
  #hash(bytes: Uint8Array | string) {
    this.#metrics.hashCalls++; this.#metrics.hashBytes += typeof bytes === 'string' ? Buffer.byteLength(bytes, 'utf8') : bytes.byteLength;
    return sha256(bytes);
  }
  #path(id: string, extension: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid_artifact_id');
    return join(this.#root, `${id}.${extension}`);
  }
  async #read(path: string, part: FilePart, maximum = 65536) {
    try {
      if (process.platform === 'win32') {
        const files = windowsProfileFiles(), directory = files.inspectDirectory(this.#root, 'private');
        if (!directory) throw new FileBoundaryFault('missing', 'directory');
        let primary: { error: unknown } | undefined;
        try {
          if (part === 'metadata') this.#metrics.metadataReadOperations++; else this.#metrics.bodyReadOperations++;
          const bytes = readWindowsFile(files, directory, basename(path), maximum);
          if (part === 'metadata') this.#metrics.metadataReadBytes += bytes.length; else this.#metrics.bodyReadBytes += bytes.length;
          return bytes;
        } catch (error) { primary = { error }; throw error; }
        finally { try { files.closeDirectory(directory); } catch (error) { if (primary) throw new AggregateError([primary.error, error], 'artifact_close_failed'); throw error; } }
      }
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat(); if (!stat.isFile()) throw new Error('invalid_artifact_file');
        if (part === 'metadata') this.#metrics.metadataReadOperations++; else this.#metrics.bodyReadOperations++;
        const bytes = await handle.readFile();
        if (part === 'metadata') this.#metrics.metadataReadBytes += bytes.byteLength; else this.#metrics.bodyReadBytes += bytes.byteLength;
        return bytes;
      } finally { await handle.close(); }
    } catch (error) { this.#metrics.readFailures++; throw error; }
  }
  async #atomic(path: string, bytes: Uint8Array, part: FilePart) {
    if (process.platform === 'win32') {
      const files = windowsProfileFiles(), scope = openProfileMutationScope(this.#root, []);
      let primary: { error: unknown } | undefined;
      try {
        const directory = scope.directory(this.#root, 'private');
        if (!directory) throw new FileBoundaryFault('missing', 'directory');
        this.#metrics.fileWrites++;
        await publishWindowsFile(files, directory, basename(path), bytes);
        const current = readWindowsFile(files, directory, basename(path), bytes.length);
        if (!current.equals(bytes)) throw new Error('artifact_integrity_failure');
        if (part === 'metadata') this.#metrics.metadataWriteBytes += bytes.length; else this.#metrics.bodyWriteBytes += bytes.length;
        syncProfileDirectory(this.#root, scope); scope.check(); return;
      } catch (error) { this.#metrics.writeFailures++; primary = { error }; throw error; }
      finally { try { scope.close(); } catch (error) { if (primary) throw new AggregateError([primary.error, error], 'artifact_close_failed'); throw error; } }
    }
    const temp = `${path}.${randomUUID()}.pending`;
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      this.#metrics.fileWrites++;
      try { await handle.writeFile(bytes); } catch (error) { this.#metrics.writeFailures++; throw error; }
      if (part === 'metadata') this.#metrics.metadataWriteBytes += bytes.byteLength; else this.#metrics.bodyWriteBytes += bytes.byteLength;
      await handle.sync();
    }
    finally { await handle.close(); }
    try { await rename(temp, path); }
    catch (error) { await unlink(temp).catch(() => {}); throw error; }
    const directory = await open(this.#root, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async put(bytes: Uint8Array, attributes: { tenantId: string; labels: string[]; mediaType: string }): Promise<ArtifactRef> {
    this.#metrics.putCalls++;
    const labels = [...new Set(attributes.labels)].sort();
    const hash = this.#hash(bytes);
    const id = this.#hash(JSON.stringify({ hash, tenantId: attributes.tenantId, labels, mediaType: attributes.mediaType }));
    const ref = parseContract(ArtifactSchema, { id, sha256: hash, byteLength: bytes.length, mediaType: attributes.mediaType, tenantId: attributes.tenantId, labels });
    if (process.platform === 'win32') {
      if (bytes.length > windowsStreamLimits.fileBytes) throw new Error('artifact_too_large');
      const scope = openProfileMutationScope(this.#root, []);
      try { profileDirectory(this.#root, true, true, scope); syncProfileDirectory(this.#root, scope); } finally { scope.close(); }
    } else await mkdir(this.#root, { recursive: true, mode: 0o700 });
    if (await this.exists(ref)) return ref;
    await this.#atomic(this.#path(id, 'blob'), bytes, 'body');
    await this.#atomic(this.#path(id, 'json'), Buffer.from(JSON.stringify(ref)), 'metadata');
    return ref;
  }
  async #verified(ref: ArtifactRef): Promise<Uint8Array> {
    try {
      parseContract(ArtifactSchema, ref);
      const stored = parseContract(ArtifactSchema, JSON.parse((await this.#read(this.#path(ref.id, 'json'), 'metadata')).toString('utf8')));
      if (stored.sha256 !== ref.sha256 || stored.byteLength !== ref.byteLength || stored.tenantId !== ref.tenantId || stored.mediaType !== ref.mediaType ||
          JSON.stringify(stored.labels) !== JSON.stringify(ref.labels) || stored.id !== ref.id) throw new Error('artifact_reference_mismatch');
      const bytes = await this.#read(this.#path(ref.id, 'blob'), 'body', ref.byteLength);
      if (bytes.length !== ref.byteLength || this.#hash(bytes) !== ref.sha256) throw new Error('artifact_integrity_failure');
      return bytes;
    } catch (error) { this.#metrics.verificationFailures++; throw error; }
  }
  async get(ref: ArtifactRef, policy: Policy): Promise<Uint8Array> {
    this.#metrics.getCalls++;
    if (ref.tenantId !== policy.tenantId || !ref.labels.every(l => policy.allowedLabels.includes(l))) {
      this.#metrics.deniedReads++; throw new Error('artifact_access_denied');
    }
    return this.#verified(ref);
  }
  async exists(ref: ArtifactRef): Promise<boolean> {
    this.#metrics.existsCalls++;
    try { await this.#verified(ref); return true; } catch { return false; }
  }
}
