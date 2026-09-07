import type { MetadataDirectory } from './host-metadata-files.js';
import { FileBoundaryFault } from './host-metadata-files.js';
import { FileMutationFault, type FilePublicationResult } from './host-file-mutations.js';
import type { WindowsMetadataFiles } from './windows-metadata-files.js';
import { windowsFileFault, type WindowsPublication, type WindowsWriteCandidate } from './windows-file-addon.js';

export const windowsStreamLimits = Object.freeze({ fileBytes: 1024 ** 3, chunkBytes: 1024 ** 2 });
function maximum(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > windowsStreamLimits.fileBytes) throw new FileBoundaryFault('invalid_request', 'read');
  return value;
}
function cleanup(close: () => void, primary: { error: unknown } | undefined) {
  try { close(); } catch (error) {
    if (primary) throw new AggregateError([primary.error, error], 'windows_stream_cleanup_failed');
    throw error;
  }
}
/** Bounded whole-record API over a stable native reader. Large copies use the reader incrementally. */
export function readWindowsFile(files: WindowsMetadataFiles, directory: MetadataDirectory, leaf: string, limit: number): Buffer {
  let reader;
  try { reader = files.handle(directory).openReadRegular(leaf, maximum(limit)); }
  catch (error) { throw windowsFileFault(error, 'open'); }
  let primary: { error: unknown } | undefined;
  try {
    const before = reader.info(), size = Number(before.bytes);
    if (!Number.isSafeInteger(size) || size < 0 || size > limit) throw new FileBoundaryFault('too_large', 'read');
    const output = Buffer.allocUnsafe(size); let offset = 0;
    for (;;) {
      const bytes = reader.read(windowsStreamLimits.chunkBytes);
      if (!bytes.length) break;
      if (offset + bytes.length > size) throw new FileBoundaryFault('changed', 'read');
      output.set(bytes, offset); offset += bytes.length;
    }
    const after = reader.info(); files.handle(directory);
    if (offset !== size || after.identity !== before.identity || after.changeToken !== before.changeToken) throw new FileBoundaryFault('changed', 'read');
    return output;
  } catch (error) { const mapped = windowsFileFault(error, 'read'); primary = { error: mapped }; throw mapped; }
  finally { cleanup(() => reader.close(), primary); }
}
export function windowsPublicationResult(outcome: WindowsPublication): FilePublicationResult {
  const result: FilePublicationResult = {
    publication: outcome.publication === 'created' ? 'published' : outcome.publication === 'unknown' ? 'unknown' : 'not_published',
    published: outcome.publication === 'created', created: !!outcome.candidateName, fileSynced: outcome.fileFlush === 'completed', directorySynced: false,
    cleanup: outcome.cleanup === 'removed' || outcome.cleanup === 'consumed_by_rename' ? 'removed' :
      outcome.cleanup === 'not_needed' ? 'not_needed' : outcome.cleanup === 'retained_ambiguous' ? 'retained' : 'unknown',
  };
  if (!outcome.ok || outcome.closeWin32Error !== undefined || outcome.cleanupWin32Error !== undefined || outcome.namespaceBarrier !== 'unsupported')
    throw new FileMutationFault('publish', outcome.phase, result, [{ stage: outcome.phase,
      error: Object.assign(new Error(outcome.code ?? 'windows_publication_failed'), { nativeOutcome: outcome }) }]);
  return Object.freeze(result);
}
function prepare(files: WindowsMetadataFiles, directory: MetadataDirectory, leaf: string, bytes: Uint8Array): WindowsWriteCandidate {
  const writer = files.handle(directory).createCandidate(leaf, maximum(bytes.byteLength), 'process-crash');
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += windowsStreamLimits.chunkBytes)
      writer.append(Buffer.from(bytes.subarray(offset, offset + windowsStreamLimits.chunkBytes)));
    writer.prepare(); return writer;
  } catch (error) { cleanup(() => writer.close(), { error }); throw error; }
}
function publicationError(error: unknown, result?: FilePublicationResult): unknown {
  if (!result || error instanceof FileMutationFault) return error;
  return new FileMutationFault('publish', 'post_publish_check', result, [{ stage: 'post_publish_check', error }]);
}
function finish(writer: WindowsWriteCandidate, primary?: { error: unknown }, result?: FilePublicationResult) {
  try { writer.close(); } catch (error) {
    const state = result ?? (primary?.error instanceof FileMutationFault ? primary.error.status : undefined);
    if (state) throw new FileMutationFault('publish', 'candidate_close', state,
      [...(primary ? [{ stage: 'primary', error: primary.error }] : []), { stage: 'candidate_close', error }]);
    if (primary) throw new AggregateError([primary.error, error], 'windows_stream_cleanup_failed');
    throw error;
  }
}
function dispatchPublication(writer: WindowsWriteCandidate): FilePublicationResult {
  let outcome: WindowsPublication;
  try { outcome = writer.publish(); }
  catch (error) {
    throw new FileMutationFault('publish', 'native_publish', { publication: 'unknown', created: true,
      fileSynced: true, directorySynced: false, cleanup: 'unknown' }, [{ stage: 'native_publish', error }]);
  }
  return windowsPublicationResult(outcome);
}
export function publishWindowsFileSync(files: WindowsMetadataFiles, directory: MetadataDirectory, leaf: string, bytes: Uint8Array): FilePublicationResult {
  const writer = prepare(files, directory, leaf, bytes); let primary: { error: unknown } | undefined, result: FilePublicationResult | undefined;
  try { result = dispatchPublication(writer); files.handle(directory); return result; }
  catch (error) { primary = { error: publicationError(error, result) }; throw primary.error; }
  finally { finish(writer, primary, result); }
}
export async function publishWindowsFile(files: WindowsMetadataFiles, directory: MetadataDirectory, leaf: string, bytes: Uint8Array,
  afterPrepared?: () => void | Promise<void>): Promise<FilePublicationResult> {
  const writer = prepare(files, directory, leaf, bytes); let primary: { error: unknown } | undefined, result: FilePublicationResult | undefined;
  try { await afterPrepared?.(); result = dispatchPublication(writer); files.handle(directory); return result; }
  catch (error) { primary = { error: publicationError(error, result) }; throw primary.error; }
  finally { finish(writer, primary, result); }
}
