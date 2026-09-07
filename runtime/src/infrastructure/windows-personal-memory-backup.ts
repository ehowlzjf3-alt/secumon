import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { FileBoundaryFault, sameFileIdentity, type FileIdentity, type MetadataDirectory } from './host-metadata-files.js';
import { FileMutationFault } from './host-file-mutations.js';
import { openWindowsDatabaseGuard } from './windows-sqlite.js';
import { windowsProfileFiles } from './windows-profile-files.js';
import { windowsPublicationResult } from './windows-stream-files.js';
import type { WindowsPathInfo, WindowsPublication } from './windows-file-addon.js';

const limit = 256 * 1024 * 1024;
function fail(code: string): never { throw new Error(`personal_memory_backup_${code}`); }
function identity(info: WindowsPathInfo): FileIdentity {
  const match = /^([a-f0-9]{8}):([a-f0-9]{16})$/.exec(info.identity);
  if (!match || info.kind !== 'regular') return fail('file_unsafe');
  return { volume: match[1]!, object: match[2]! };
}
function matches(info: WindowsPathInfo, expected?: FileIdentity) {
  const actual = identity(info);
  if (expected && !sameFileIdentity(actual, expected)) fail('file_changed');
  return actual;
}
/** SQLite-compatible metadata handles only; never opens a raw data descriptor on the source. */
export function windowsBackupInfo(path: string): WindowsPathInfo {
  const guard = openWindowsDatabaseGuard(path, false);
  if (!guard) throw Object.assign(new Error('personal_memory_backup_source_missing'), { code: 'ENOENT' });
  let primary: { error: unknown } | undefined;
  try { return guard.info(); }
  catch (error) { primary = { error }; throw error; }
  finally { try { guard.close(); } catch (close) {
    if (primary) throw new AggregateError([primary.error, close], 'personal_memory_backup_metadata_close', { cause: primary.error });
    throw close;
  } }
}
export function windowsBackupIdentity(path: string, expected?: FileIdentity): FileIdentity { return matches(windowsBackupInfo(path), expected); }

/** Every SQLite connection must have closed. Incremental read and native exclusive flush keep the existing 256 MiB limit. */
export function hashAndSyncWindowsBackup(path: string, expected: FileIdentity, guard: () => void, deadline: number) {
  const files = windowsProfileFiles(), directory = files.inspectDirectory(dirname(path), 'private');
  if (!directory) throw new FileBoundaryFault('missing', 'directory');
  let reader: ReturnType<ReturnType<typeof files.handle>['openReadRegular']> | undefined;
  const errors: unknown[] = []; let result: { sha256: string; byteLength: number } | undefined;
  try {
    guard(); reader = files.handle(directory).openReadRegular(basename(path), limit);
    const before = reader.info(); matches(before, expected);
    const hash = createHash('sha256'); let count = 0;
    for (;;) {
      if (performance.now() > deadline) fail('deadline');
      const bytes = reader.read(64 * 1024); if (!bytes.length) break;
      count += bytes.length; if (count > limit) fail('capacity'); hash.update(bytes);
    }
    const after = reader.info();
    if (after.identity !== before.identity || after.changeToken !== before.changeToken || String(count) !== before.bytes) fail('file_changed');
    const closing = reader; reader = undefined; closing.close();
    files.handle(directory).syncRegular(basename(path), before);
    const named = files.inspectChild(directory, basename(path), true);
    if (!named || named.identity !== before.identity || named.changeToken !== before.changeToken) fail('file_changed');
    guard(); result = { sha256: hash.digest('hex'), byteLength: count };
  } catch (error) { errors.push(error); }
  try { reader?.close(); } catch (error) { errors.push(error); }
  try { files.closeDirectory(directory); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'personal_memory_backup_hash_close', { cause: errors[0] });
  return result!;
}

/** No replacement and no copy: the verified candidate's native identity survives publication. */
export function publishWindowsBackup(source: MetadataDirectory, target: MetadataDirectory, expected: FileIdentity) {
  const files = windowsProfileFiles(), candidate = files.inspectChild(source, 'candidate.sqlite', true);
  if (!candidate) return fail('candidate_missing'); matches(candidate, expected);
  let outcome: WindowsPublication;
  try { outcome = files.handle(source).publishExisting('candidate.sqlite', files.handle(target), 'backup.sqlite', candidate); }
  catch (error) {
    throw new FileMutationFault('publish', 'backup_native_publish', { publication: 'unknown', created: true,
      fileSynced: true, directorySynced: false, cleanup: 'unknown' }, [{ stage: 'backup_native_publish', error }]);
  }
  const published = windowsPublicationResult(outcome);
  try {
    files.handle(source); const current = files.inspectChild(target, 'backup.sqlite', true);
    if (!current) fail('publication_missing'); matches(current!, expected);
    return published;
  } catch (error) { throw new FileMutationFault('publish', 'backup_post_publish', published, [{ stage: 'backup_post_publish', error }]); }
}
