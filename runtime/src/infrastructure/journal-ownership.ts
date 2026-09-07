import { opendirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { FileBoundaryFault, hostMetadataFiles, metadataFileAllowed, sameFileIdentity, releaseMetadataDirectory, type MetadataDirectory, type MetadataObserver, type MetadataSiblings, type MetadataSnapshot } from './host-metadata-files.js';
import { WindowsMetadataFiles } from './windows-metadata-files.js';

export class JournalStateError extends Error { constructor(readonly code: string, cause?: unknown) { super(code, cause === undefined ? undefined : { cause }); } }
export const JournalOwnerSchema = z.strictObject({ agentId: z.uuid(), kind: z.literal('state') });
export type JournalOwner = z.infer<typeof JournalOwnerSchema>;
export const JournalHeaderSchema = z.discriminatedUnion('schemaVersion', [
  z.strictObject({ kind: z.literal('long-horizon-file-journal'), schemaVersion: z.literal(1), storeId: z.uuid() }),
  z.strictObject({ kind: z.literal('long-horizon-file-journal'), schemaVersion: z.literal(2), storeId: z.uuid(), owner: JournalOwnerSchema }),
]);
export type JournalHeader = z.infer<typeof JournalHeaderSchema>;
const pendingName = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pending$/;
const nativePendingName = /^\.secumon-init-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pending$/;
const maximumHeaderBytes = 4096;
const maximumPending = 512;
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const fail = (code: string): never => { throw new JournalStateError(code); };
const waitCell = new Int32Array(new SharedArrayBuffer(4));
export function copyJournalOwner(value: JournalOwner): Readonly<JournalOwner> {
  const parsed = JournalOwnerSchema.safeParse(value);
  if (!parsed.success) return fail('journal_owner_invalid');
  return Object.freeze(parsed.data);
}
export function assertJournalOwner(header: JournalHeader, expected?: Readonly<JournalOwner>): void {
  if (header.schemaVersion === 1) { if (expected) fail('journal_owner_missing'); return; }
  if (!expected) return fail('journal_owner_required');
  if (header.owner.agentId !== expected.agentId || header.owner.kind !== expected.kind) fail('journal_owner_mismatch');
}
export function parseJournalHeader(bytes: Uint8Array, expected?: Readonly<JournalOwner>): JournalHeader {
  let header: JournalHeader;
  try { header = JournalHeaderSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch (error) { throw new JournalStateError('journal_format_invalid', error); }
  assertJournalOwner(header, expected); return header;
}
type ReadObserver = MetadataObserver;
function linkedPublication(name: string, file: MetadataSnapshot, siblings: MetadataSiblings, observer?: ReadObserver): boolean {
  if (file.links === 1n) return true;
  if (file.links !== 2n) return false;
  const inspect = (candidate: string) => {
    observer?.metadata(); const entry = siblings.inspect(candidate);
    return entry !== null && metadataFileAllowed(entry, 'private') && entry.links === 2n && sameFileIdentity(entry.identity, file.identity);
  };
  if (pendingName.test(name)) return inspect('format.json');
  if (name !== 'format.json') return false;
  let examinedPending = 0;
  for (const candidate of siblings.names()) {
    if (!pendingName.test(candidate)) continue;
    if (++examinedPending > maximumPending) fail('journal_pending_limit');
    if (inspect(candidate)) return true;
  }
  return false;
}

function missingMetadata(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error('journal metadata path does not exist'), { code: 'ENOENT', path });
}

/** Bounded header reads. Native directory references are released after each independent preflight. */
export function readJournalMetadata(path: string, maximum = maximumHeaderBytes, observer?: ReadObserver): Buffer {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > maximumHeaderBytes) return fail('journal_record_too_large');
  try {
    const files = hostMetadataFiles(); const parent = files.inspectDirectory(dirname(path), 'traverse');
    if (!parent) throw missingMetadata(path);
    const name = basename(path); let primary: unknown, failed = false;
    try {
      return files.readStableRegularFile(parent, name, { maximum, access: 'private',
        allowLinkedFile: (file, siblings) => linkedPublication(name, file, siblings, observer),
        ...(observer ? { observer } : {}),
      });
    } catch (error) { primary = error; failed = true; throw error; }
    finally {
      try { releaseMetadataDirectory(files, parent); }
      catch (close) { if (failed) throw new AggregateError([primary, close], 'journal_metadata_close_failed', { cause: primary }); throw close; }
    }
  } catch (error) {
    if (!(error instanceof FileBoundaryFault)) throw error;
    if (error.code === 'missing') throw process.platform === 'win32' ? Object.assign(missingMetadata(path), { cause: error }) : error.cause ?? missingMetadata(path);
    if (error.code === 'unsupported_platform') throw new JournalStateError('journal_platform_unsupported', error);
    if (error.code === 'changed') throw new JournalStateError('journal_record_changed', error);
    if (error.code === 'too_large') throw new JournalStateError('journal_record_too_large', error);
    if (error.code === 'unsafe' || error.code === 'invalid_request' || error.operation === 'open' || error.operation === 'directory') {
      throw new JournalStateError('journal_file_unsafe', error.cause ?? error);
    }
    throw error.cause ?? error;
  }
}

function directoryIdentity(path: string, missingAllowed = false): MetadataDirectory | null {
  try {
    const directory = hostMetadataFiles().inspectDirectory(path, 'private');
    if (!directory && !missingAllowed) throw new JournalStateError('journal_directory_unavailable', missingMetadata(path));
    return directory;
  } catch (error) {
    if (error instanceof JournalStateError) throw error;
    if (error instanceof FileBoundaryFault) {
      if (error.code === 'unsupported_platform') throw new JournalStateError('journal_platform_unsupported', error);
      if (error.code === 'unsafe') throw new JournalStateError('journal_directory_unsafe', error);
      if (error.code === 'changed') throw new JournalStateError('journal_directory_changed', error);
      if (error.code === 'missing' && missingAllowed) return null;
      throw new JournalStateError('journal_directory_unavailable', error.cause ?? error);
    }
    if (missingAllowed && errorCode(error) === 'ENOENT') return null;
    throw new JournalStateError('journal_directory_unavailable', error);
  }
}

/** Also used by initialization without an owner, preserving valid standalone v1 header candidates. */
export function inspectJournalInitialization(directory: string, expected?: Readonly<JournalOwner>): 'uninitialized' | 'owned' {
  const root = resolve(directory); const identity = directoryIdentity(root, true);
  if (!identity) return 'uninitialized';
  const files = hostMetadataFiles();
  const checkRoot = () => {
    const current = directoryIdentity(root)!;
    try { if (!sameFileIdentity(current.identity, identity.identity)) fail('journal_directory_changed'); }
    finally { releaseMetadataDirectory(files, current); }
  };
  const published = () => {
    try { parseJournalHeader(readJournalMetadata(join(root, 'format.json')), expected); checkRoot(); return true; }
    catch (error) { if (errorCode(error) === 'ENOENT') return false; throw error; }
  };
  let primary: unknown, failed = false;
  try {
    for (let retry = 0; retry < 20; retry++) {
      if (published()) return 'owned';
      try {
        let count = 0;
        const inspectName = (name: string) => {
          if (name === 'format.json') return published();
          if (!pendingName.test(name) && !(files instanceof WindowsMetadataFiles && nativePendingName.test(name))) fail('journal_format_missing');
          if (++count > maximumPending) fail('journal_pending_limit');
          parseJournalHeader(readJournalMetadata(join(root, name)), expected); return false;
        };
        if (files instanceof WindowsMetadataFiles) {
          for (const name of files.names(identity, maximumPending + 1)) if (inspectName(name)) return 'owned';
        } else {
          const handle = opendirSync(root);
          try { for (let entry = handle.readSync(); entry; entry = handle.readSync()) if (inspectName(entry.name)) return 'owned'; }
          finally { handle.closeSync(); }
        }
        checkRoot();
        return published() ? 'owned' : 'uninitialized';
      } catch (error) {
        if (published()) return 'owned';
        const pendingSharing = files instanceof WindowsMetadataFiles && error instanceof Error && /windows_file:win32_io:[^:]+:(32|33)\b/.test(error.message);
        const retryable = pendingSharing || errorCode(error) === 'ENOENT' || error instanceof JournalStateError &&
          ['journal_format_invalid', 'journal_record_changed'].includes(error.code);
        if (!retryable || retry === 19) throw error;
        // Another initializer may be between creating and syncing its candidate.
        Atomics.wait(waitCell, 0, 0, 5);
      }
    }
    return fail('journal_format_invalid');
  } catch (error) { primary = error; failed = true; throw error; }
  finally {
    try { releaseMetadataDirectory(files, identity); }
    catch (close) { if (failed) throw new AggregateError([primary, close], 'journal_owner_close_failed', { cause: primary }); throw close; }
  }
}

/** Read-only owner preflight: never creates a directory, header, or replacement store ID. */
export function inspectJournalOwnership(directory: string, expectedOwner: JournalOwner): 'uninitialized' | 'owned' {
  return inspectJournalInitialization(directory, copyJournalOwner(expectedOwner));
}
