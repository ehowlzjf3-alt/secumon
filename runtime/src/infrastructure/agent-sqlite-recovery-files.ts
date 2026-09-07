import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, opendirSync, readSync, realpathSync, unlinkSync, type BigIntStats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { SqliteRecoveryFilePin } from '../application/agent-sqlite-recovery-contracts.js';
import { copyLifecycleFile, lifecycleLimits } from './agent-lifecycle-files.js';
import { completeMetadataPublication, hostMetadataFiles, sameFileIdentity, type MetadataDirectory } from './host-metadata-files.js';
import { hostFileMutations, type HostFileMutationScope } from './host-file-mutations.js';
import { WindowsMetadataFiles } from './windows-metadata-files.js';
import { windowsPublicationResult, windowsStreamLimits } from './windows-stream-files.js';
import type { WindowsPathInfo } from './windows-file-addon.js';

// Callers must hold the existing maintenance lease and close every SQLite connection before using raw files.
const chunkBytes = windowsStreamLimits.chunkBytes;
const journalMagic = Buffer.from('d9d505f920a163d7', 'hex');
const sqliteMagic = Buffer.from('SQLite format 3\0');
const fail: (code: string) => never = code => { throw new Error(`sqlite_recovery_${code}`); };
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const key = (path: string) => process.platform === 'win32' ? resolve(path).toUpperCase() : resolve(path);
function limit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > lifecycleLimits.fileBytes) fail('file_limit_invalid');
  return value;
}
function checkedPin(value: SqliteRecoveryFilePin, maximum: number): SqliteRecoveryFilePin {
  if (!value || !value.identity || typeof value.identity.volume !== 'string' || !value.identity.volume ||
    typeof value.identity.object !== 'string' || !value.identity.object || !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 || value.bytes > maximum || !/^[a-f0-9]{64}$/.test(value.sha256)) fail('file_pin_invalid');
  return value;
}
const sameContent = (a: SqliteRecoveryFilePin, b: SqliteRecoveryFilePin) => a.bytes === b.bytes && a.sha256 === b.sha256;
const samePin = (a: SqliteRecoveryFilePin, b: SqliteRecoveryFilePin) => sameContent(a, b) && sameFileIdentity(a.identity, b.identity);
function requirePin(actual: SqliteRecoveryFilePin | null, expected: SqliteRecoveryFilePin | null): void {
  if (actual === null ? expected !== null : expected === null || !samePin(actual, expected)) fail('file_changed');
}
function finish(actions: readonly (() => void)[], original?: { error: unknown }): void {
  const errors: unknown[] = original ? [original.error] : [];
  for (const action of actions) try { action(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'sqlite_recovery_files_close_failed', { cause: errors[0] });
}
type Parent = { path: string; scope: HostFileMutationScope; directory: MetadataDirectory };
type Observed = { pin: SqliteRecoveryFilePin; header: Buffer; tail: Buffer; native?: WindowsPathInfo };
type LinkedPeer = string | readonly string[];

/** Holds only existing private parents. No implicit directory creation or database connection. */
class Files {
  readonly files = hostMetadataFiles();
  readonly #parents = new Map<string, Parent>();
  constructor(paths: readonly string[]) {
    try {
      for (const path of paths) {
        const parentPath = dirname(resolve(path)); if (this.#parents.has(key(parentPath))) continue;
        const scope = hostFileMutations().openScope({ root: parentPath, forbiddenRoots: [] });
        try {
          const directory = scope.directory(parentPath, 'private'); if (!directory) fail('directory_missing');
          this.#parents.set(key(parentPath), { path: parentPath, scope, directory });
        } catch (error) { finish([() => scope.close()], { error }); }
      }
    } catch (error) { finish([() => this.close()], { error }); }
  }
  parent(path: string): Parent {
    const parent = this.#parents.get(key(dirname(resolve(path))));
    if (!parent) return fail('directory_unregistered'); parent.scope.check(); return parent;
  }
  check(): void { for (const parent of this.#parents.values()) parent.scope.check(); }
  barrier(path: string): void {
    const parent = this.parent(path); completeMetadataPublication(this.files, parent.directory); this.check();
  }
  names(path: string): string[] {
    const parent = this.parent(path), names: string[] = [];
    if (this.files instanceof WindowsMetadataFiles) return this.files.names(parent.directory, 65536);
    const directory = opendirSync(parent.path);
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (names.length >= 65536) fail('directory_limit'); names.push(entry.name);
      }
    } finally { directory.closeSync(); }
    this.check(); return names;
  }
  #stat(path: string): BigIntStats | null {
    try { return lstatSync(path, { bigint: true }); } catch (error) { if (missing(error)) return null; throw error; }
  }
  #safe(stat: BigIntStats, path: string, pair?: LinkedPeer): void {
    if (!stat.isFile() || stat.isSymbolicLink() || typeof process.getuid !== 'function' || stat.uid !== BigInt(process.getuid()) ||
      (stat.mode & 0o177n) !== 0n) fail('file_unsafe');
    if (stat.nlink === 1n) return;
    if (stat.nlink !== 2n || !pair) fail('file_links_invalid');
    for (const peer of typeof pair === 'string' ? [pair] : pair) {
      if (key(path) === key(peer)) continue;
      this.parent(peer); const other = this.#stat(peer);
      if (other?.isFile() && !other.isSymbolicLink() && other.nlink === 2n && other.dev === stat.dev && other.ino === stat.ino) return;
    }
    fail('file_links_invalid');
  }
  read(path: string, maximum: number, pair?: LinkedPeer, flush = false): Observed | null {
    limit(maximum); const parent = this.parent(path), name = basename(path);
    const hash = createHash('sha256'); let bytes = 0, header = Buffer.alloc(0), tail = Buffer.alloc(0);
    const add = (part: Buffer) => {
      bytes += part.length; if (bytes > maximum) fail('file_too_large'); hash.update(part);
      if (header.length < 100) header = Buffer.concat([header, part.subarray(0, 100 - header.length)]);
      tail = Buffer.concat([tail, part.subarray(Math.max(0, part.length - 16))]).subarray(-16);
    };
    if (this.files instanceof WindowsMetadataFiles) {
      const files = this.files, before = files.inspectChild(parent.directory, name, true);
      if (!before) { this.check(); return null; }
      const match = /^([a-f0-9]{8}):([a-f0-9]{16})$/.exec(before.identity);
      if (!match || before.kind !== 'regular' || !/^(0|[1-9][0-9]*)$/.test(before.bytes)) return fail('file_unsafe');
      if (BigInt(before.bytes) > BigInt(maximum)) fail('file_too_large');
      const reader = files.handle(parent.directory).openReadRegular(name, maximum); let original: { error: unknown } | undefined;
      try {
        if (JSON.stringify(reader.info()) !== JSON.stringify(before)) fail('file_changed');
        for (;;) { const part = reader.read(chunkBytes); if (!part.length) break; add(part); }
        if (String(bytes) !== before.bytes || JSON.stringify(reader.info()) !== JSON.stringify(before) ||
          JSON.stringify(files.inspectChild(parent.directory, name, true)) !== JSON.stringify(before)) fail('file_changed');
        this.check();
      } catch (error) { original = { error }; throw error; }
      finally { finish([() => reader.close()], original); }
      if (flush) files.handle(parent.directory).syncRegular(name, before);
      this.check();
      return { pin: Object.freeze({ identity: Object.freeze({ volume: match[1]!, object: match[2]! }), bytes, sha256: hash.digest('hex') }), header, tail, native: before };
    }
    const before = this.#stat(path); if (!before) { this.check(); return null; }
    this.#safe(before, path, pair); if (before.size > BigInt(maximum)) fail('file_too_large');
    const stamp = (value: BigIntStats) => [value.dev, value.ino, value.mode, value.uid, value.gid, value.nlink,
      value.size, value.mtimeNs, value.ctimeNs].join(':');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let original: { error: unknown } | undefined;
    try {
      if (stamp(fstatSync(fd, { bigint: true })) !== stamp(before)) fail('file_changed');
      const buffer = Buffer.allocUnsafe(chunkBytes);
      for (;;) { const count = readSync(fd, buffer, 0, buffer.length, null); if (!count) break; add(buffer.subarray(0, count)); }
      const after = fstatSync(fd, { bigint: true }), named = this.#stat(path);
      if (!named || BigInt(bytes) !== before.size || stamp(after) !== stamp(before) || stamp(named) !== stamp(before)) fail('file_changed');
      this.#safe(after, path, pair); this.check(); if (flush) fsyncSync(fd);
      return { pin: Object.freeze({ identity: Object.freeze({ volume: String(before.dev), object: String(before.ino) }), bytes, sha256: hash.digest('hex') }), header, tail };
    } catch (error) { original = { error }; throw error; }
    finally { finish([() => closeSync(fd)], original); }
  }
  move(source: string, target: string, expected: SqliteRecoveryFilePin, maximum: number): SqliteRecoveryFilePin {
    checkedPin(expected, maximum); if (key(source) === key(target)) fail('file_overlap');
    const from = this.parent(source), to = this.parent(target);
    let sourceFile = this.read(source, maximum, target), targetFile = this.read(target, maximum, source);
    if (!sourceFile) {
      requirePin(targetFile?.pin ?? null, expected);
      requirePin(this.read(target, maximum, undefined, true)?.pin ?? null, expected);
      this.barrier(target); if (key(from.path) !== key(to.path)) this.barrier(source);
      return targetFile!.pin;
    }
    requirePin(sourceFile.pin, expected);
    if (targetFile) requirePin(targetFile.pin, expected);
    if (this.files instanceof WindowsMetadataFiles) {
      if (targetFile) return fail('publication_conflict');
      const outcome = this.files.handle(from.directory).publishExisting(basename(source), this.files.handle(to.directory), basename(target), sourceFile.native!);
      windowsPublicationResult(outcome);
      if (outcome.publication !== 'created' || outcome.fileFlush !== 'completed') fail('publication_unconfirmed');
    } else {
      if (!targetFile) {
        sourceFile = this.read(source, maximum, undefined, true); requirePin(sourceFile?.pin ?? null, expected);
        try { linkSync(source, target); } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error; }
      } else requirePin(this.read(source, maximum, target, true)?.pin ?? null, expected);
      // An interrupted link-before-unlink publication may have exactly these two names for one inode.
      requirePin(this.read(source, maximum, target)?.pin ?? null, expected);
      targetFile = this.read(target, maximum, source); requirePin(targetFile?.pin ?? null, expected);
      this.barrier(target);
      requirePin(this.read(source, maximum, target)?.pin ?? null, expected); this.check();
      unlinkSync(source);
    }
    this.barrier(target); if (key(from.path) !== key(to.path)) this.barrier(source);
    requirePin(this.read(source, maximum)?.pin ?? null, null);
    const published = this.read(target, maximum); requirePin(published?.pin ?? null, expected);
    return published!.pin;
  }
  close(): void { const values = [...this.#parents.values()]; this.#parents.clear(); finish(values.reverse().map(value => () => value.scope.close())); }
}
function using<T>(paths: readonly string[], action: (files: Files) => T): T {
  const files = new Files(paths.map(resolvePath)); let original: { error: unknown } | undefined;
  try { return action(files); } catch (error) { original = { error }; throw error; }
  finally { finish([() => files.close()], original); }
}
function resolvePath(path: string): string {
  if (typeof path !== 'string' || !path || /[\x00-\x1f\x7f]/.test(path)) return fail('path_invalid');
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute : join(realpathSync(dirname(absolute)), basename(absolute));
}
export function captureSqliteRecoveryFile(path: string, maximumBytes: number): SqliteRecoveryFilePin | null {
  const source = resolvePath(path); return using([source], files => files.read(source, limit(maximumBytes))?.pin ?? null);
}
export function assertSqliteRecoveryFile(path: string, expected: SqliteRecoveryFilePin | null, maximumBytes: number): void {
  if (expected) checkedPin(expected, limit(maximumBytes)); requirePin(captureSqliteRecoveryFile(path, maximumBytes), expected);
}
export function assertSqliteRecoveryLayout(mainPath: string): void {
  const main = resolvePath(mainPath), name = basename(main), equal = (value: string) => process.platform === 'win32' ? value.toUpperCase() : value;
  using([main], files => {
    for (const child of files.names(main)) {
      const value = equal(child);
      if (value === equal(`${name}-wal`) || value === equal(`${name}-shm`) || value.startsWith(equal(`${name}-mj`))) fail('journal_mode_unsupported');
    }
    files.check();
  });
}
export function assertSqliteRecoveryJournal(mainPath: string, expectedMain: SqliteRecoveryFilePin,
  expectedJournal: SqliteRecoveryFilePin, maximumBytes: number): void {
  const main = resolvePath(mainPath), journal = `${main}-journal`, maximum = limit(maximumBytes);
  checkedPin(expectedMain, maximum); checkedPin(expectedJournal, maximum); assertSqliteRecoveryLayout(main);
  using([main], files => {
    const db = files.read(main, maximum), rollback = files.read(journal, maximum);
    requirePin(db?.pin ?? null, expectedMain); requirePin(rollback?.pin ?? null, expectedJournal);
    if (!db || !rollback) return fail('journal_missing');
    const power = (value: number) => value >= 512 && value <= 65536 && (value & (value - 1)) === 0;
    if (db.header.length < 100 || !db.header.subarray(0, 16).equals(sqliteMagic) || db.header[18] !== 1 || db.header[19] !== 1)
      fail('journal_mode_unsupported');
    const encoded = db.header.readUInt16BE(16), page = encoded === 1 ? 65536 : encoded;
    if (!power(page) || rollback.pin.bytes <= 512 || rollback.header.length < 28 || !rollback.header.subarray(0, 8).equals(journalMagic))
      fail('journal_invalid');
    const sector = rollback.header.readUInt32BE(20), journalPage = rollback.header.readUInt32BE(24);
    if (!power(sector) || !power(journalPage) || page !== journalPage || rollback.pin.bytes <= sector) fail('journal_invalid');
    // Never follow a trailer's external super-journal filename, even when it currently does not exist.
    if (rollback.tail.subarray(-8).equals(journalMagic)) fail('super_journal_unsupported');
    requirePin(files.read(main, maximum)?.pin ?? null, expectedMain);
    requirePin(files.read(journal, maximum)?.pin ?? null, expectedJournal); files.check();
  });
  assertSqliteRecoveryLayout(main);
}
export function copySqliteRecoveryFile(source: string, destination: string, expected: SqliteRecoveryFilePin, maximumBytes: number): SqliteRecoveryFilePin {
  const from = resolvePath(source), to = resolvePath(destination), maximum = limit(maximumBytes); checkedPin(expected, maximum);
  if (key(from) === key(to)) fail('file_overlap');
  return using([from, to], files => {
    requirePin(files.read(from, maximum)?.pin ?? null, expected);
    const prior = files.read(to, maximum);
    if (prior) {
      if (!sameContent(prior.pin, expected) || sameFileIdentity(prior.pin.identity, expected.identity)) fail('copy_conflict');
      requirePin(files.read(to, maximum, undefined, true)?.pin ?? null, prior.pin); files.barrier(to);
      requirePin(files.read(from, maximum)?.pin ?? null, expected); return prior.pin;
    }
    copyLifecycleFile(from, to, { kind: 'file', path: basename(from), bytes: expected.bytes, sha256: expected.sha256, executable: false });
    files.barrier(to); requirePin(files.read(from, maximum)?.pin ?? null, expected);
    const copied = files.read(to, maximum);
    if (!copied || !sameContent(copied.pin, expected) || sameFileIdentity(copied.pin.identity, expected.identity)) return fail('copy_changed');
    return copied.pin;
  });
}
export function retireSqliteRecoveryFile(path: string, operationId: string, expected: SqliteRecoveryFilePin | null, maximumBytes: number,
  publishedCandidate?: { readonly path: string; readonly pin: SqliteRecoveryFilePin }): SqliteRecoveryFilePin | null {
  const source = resolvePath(path), maximum = limit(maximumBytes);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId)) fail('operation_invalid');
  const retired = join(dirname(source), `${basename(source)}.retired-${operationId}`);
  const candidate = publishedCandidate ? { path: resolvePath(publishedCandidate.path), pin: checkedPin(publishedCandidate.pin, maximum) } : undefined;
  if (candidate && (!expected || key(candidate.path) === key(source) || key(candidate.path) === key(retired) ||
    sameFileIdentity(candidate.pin.identity, expected.identity))) fail('candidate_invalid');
  return using(candidate ? [source, candidate.path] : [source], files => {
    if (expected === null) { requirePin(files.read(source, maximum)?.pin ?? null, null); requirePin(files.read(retired, maximum)?.pin ?? null, null); return null; }
    checkedPin(expected, maximum);
    if (candidate) {
      const original = files.read(retired, maximum, source);
      if (original) {
        requirePin(original.pin, expected);
        const main = files.read(source, maximum, [retired, candidate.path]);
        if (main && samePin(main.pin, candidate.pin)) {
          const remainingCandidate = files.read(candidate.path, maximum, source);
          if (remainingCandidate) requirePin(remainingCandidate.pin, candidate.pin);
          // The original is already retired. Only the candidate publisher may remove its extra link.
          requirePin(files.read(retired, maximum, undefined, true)?.pin ?? null, expected); files.barrier(retired);
          requirePin(files.read(source, maximum, candidate.path)?.pin ?? null, candidate.pin);
          return original.pin;
        }
      }
    }
    return files.move(source, retired, expected, maximum);
  });
}
export function publishSqliteRecoveryCandidate(candidate: string, mainPath: string, expected: SqliteRecoveryFilePin, maximumBytes: number): SqliteRecoveryFilePin {
  const source = resolvePath(candidate), target = resolvePath(mainPath), maximum = limit(maximumBytes);
  assertSqliteRecoveryLayout(target);
  return using([source, target], files => files.move(source, target, expected, maximum));
}
