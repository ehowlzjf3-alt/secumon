import { win32 } from 'node:path';
import { FileBoundaryFault, type MetadataDirectory, type MetadataObserver } from './host-metadata-files.js';
import { hostFileMutations, FileMutationFault, type HostFileMutationScope } from './host-file-mutations.js';
import { WindowsMetadataFiles, windowsAbsolutePath } from './windows-metadata-files.js';
import { readWindowsFile, publishWindowsFile } from './windows-stream-files.js';

export type WindowsJournalRecordIdentity = { dev: string; ino: string };
const missing = (path: string) => Object.assign(new Error('journal path does not exist'), { code: 'ENOENT', path });
function identity(value: string): WindowsJournalRecordIdentity {
  const match = /^([0-9a-f]{8}):([0-9a-f]{16})$/.exec(value);
  if (!match) throw new FileBoundaryFault('io', 'read', new Error('windows_file_identity_invalid'));
  return { dev: match[1]!, ino: match[2]! };
}
/** Native handles and no-replace publication; this does not provide a namespace/power-loss barrier. */
export class WindowsJournalFiles {
  readonly root: string;
  readonly parent: MetadataDirectory;
  readonly directory: MetadataDirectory;
  readonly #scope: HostFileMutationScope;
  #closed = false;
  constructor(readonly files: WindowsMetadataFiles, input: string) {
    this.root = windowsAbsolutePath(win32.resolve(input));
    if (win32.dirname(this.root) === this.root) throw new FileBoundaryFault('invalid_request', 'directory');
    const parent = files.inspectDirectory(win32.dirname(this.root), 'traverse');
    if (!parent) throw missing(win32.dirname(this.root));
    this.parent = parent;
    let scope: HostFileMutationScope | undefined;
    try {
      scope = hostFileMutations().openScope({ root: this.root, forbiddenRoots: [] });
      const directory = scope.directory(this.root, 'private', true);
      if (!directory) throw missing(this.root);
      this.#scope = scope; this.directory = directory;
    } catch (error) {
      const failures: unknown[] = [error];
      try { scope?.close(); } catch (close) { failures.push(close); }
      try { files.closeDirectory(parent); } catch (close) { failures.push(close); }
      if (failures.length > 1) throw new AggregateError(failures, 'windows_journal_open_failed', { cause: error });
      throw error;
    }
  }
  check() {
    if (this.#closed) throw new FileBoundaryFault('invalid_request', 'directory');
    this.files.handle(this.parent); this.#scope.check();
  }
  child(path: string, expected?: MetadataDirectory, create = false): MetadataDirectory | null {
    this.check();
    const directory = this.#scope.directory(path, 'private', create);
    if (expected && (!directory || directory.identity.volume !== expected.identity.volume || directory.identity.object !== expected.identity.object))
      throw new FileBoundaryFault('changed', 'directory');
    return directory;
  }
  names(path: string): string[] {
    const directory = this.child(path); if (!directory) throw missing(path);
    return this.files.names(directory, 65536);
  }
  read(path: string, maximum: number, expected?: WindowsJournalRecordIdentity, observed?: (value: WindowsJournalRecordIdentity) => void, observer?: MetadataObserver): Buffer {
    const directory = this.child(win32.dirname(path)); if (!directory) throw missing(path);
    const leaf = win32.basename(path);
    for (let retry = 0; retry < 2; retry++) {
      try {
        observer?.metadata(); const before = this.files.inspectChild(directory, leaf, true);
        if (!before) throw missing(path);
        if (before.kind !== 'regular') throw new FileBoundaryFault('unsafe', 'read');
        if (BigInt(before.bytes) > BigInt(maximum)) throw new FileBoundaryFault('too_large', 'read');
        const known = identity(before.identity);
        if (expected && (expected.dev !== known.dev || expected.ino !== known.ino)) throw new FileBoundaryFault('changed', 'read');
        const bytes = readWindowsFile(this.files, directory, leaf, maximum); observer?.read(bytes.length);
        observer?.metadata(); const after = this.files.inspectChild(directory, leaf, true);
        if (!after || after.kind !== 'regular' || before.identity !== after.identity || before.changeToken !== after.changeToken ||
          before.bytes !== after.bytes || BigInt(bytes.length) !== BigInt(before.bytes)) throw new FileBoundaryFault('changed', 'read');
        this.check(); observed?.(known); return bytes;
      } catch (error) {
        if (error instanceof FileBoundaryFault && error.code === 'missing') throw Object.assign(missing(path), { cause: error });
        if (!(error instanceof FileBoundaryFault) || error.code !== 'changed' || retry) throw error;
      }
    }
    throw new FileBoundaryFault('changed', 'read');
  }
  publishHeader(bytes: Uint8Array) { this.check(); return this.#scope.publish(this.directory, 'format.json', bytes); }
  async publish(path: string, bytes: Uint8Array, afterPrepared: () => void | Promise<void>) {
    const directory = this.child(win32.dirname(path)); if (!directory) throw missing(path);
    const result = await publishWindowsFile(this.files, directory, win32.basename(path), bytes, async () => { await afterPrepared(); this.check(); });
    try { this.check(); }
    catch (error) { throw new FileMutationFault('publish', 'journal_scope_check', result, [{ stage: 'journal_scope_check', error }]); }
    return result;
  }
  close() {
    if (this.#closed) return; this.#closed = true;
    const failures: unknown[] = [];
    try { this.#scope.close(); } catch (error) { failures.push(error); }
    try { this.files.closeDirectory(this.parent); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'windows_journal_close_failed', { cause: failures[0] });
  }
}
