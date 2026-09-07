import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, readdirSync, unlinkSync, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { PersonalMemorySnapshotSchema, type PersonalMemorySnapshot } from '../application/personal-memory-migration-contracts.js';
import { FileMutationFault, hostFileMutations, type FilePublication, type HostFileMutationScope } from './host-file-mutations.js';
import { FileBoundaryFault, hostMetadataFiles, sameFileIdentity, completeMetadataPublication, type FileIdentity, type MetadataDirectory } from './host-metadata-files.js';
import { windowsProfileFiles } from './windows-profile-files.js';
import { windowsBackupInfo, windowsBackupIdentity, hashAndSyncWindowsBackup, publishWindowsBackup } from './windows-personal-memory-backup.js';

export const personalMemoryBackupLimits = Object.freeze({ bytes: 256 * 1024 * 1024, workerMs: 60_000, rate: 256, attempts: 4 });
const digest = z.string().regex(/^[a-f0-9]{64}$/), identitySchema = z.strictObject({ volume: z.string(), object: z.string() });
const expectedSchema = z.strictObject({ expectedSnapshotDigest: digest, expectedOwnerDigest: digest, expectedWorkDigest: digest });
const optionsSchema = expectedSchema.extend({ operationId: z.uuid(), agentId: z.uuid(), sourcePath: z.string().min(1),
  operationDirectory: z.string().min(1), forbiddenRoots: z.array(z.string().min(1)) }).strict();
export type PersonalMemoryBackupOptions = z.infer<typeof optionsSchema>;
const intentSchema = expectedSchema.extend({ schemaVersion: z.literal(1), operationId: z.uuid(), agentId: z.uuid(),
  sourcePath: z.string(), sourceIdentity: identitySchema, sourceDirectoryIdentity: identitySchema }).strict();
type Intent = z.infer<typeof intentSchema>;
const measurementSchema = z.strictObject({ snapshot: PersonalMemorySnapshotSchema, sha256: digest,
  byteLength: z.number().int().positive().max(personalMemoryBackupLimits.bytes), identity: identitySchema,
  pageSize: z.number().int().positive(), pageCount: z.number().int().nonnegative(), sqliteVersion: z.string(), nodeVersion: z.string() });
type Measurement = z.infer<typeof measurementSchema>;
const verifiedSchema = z.strictObject({ schemaVersion: z.literal(1), operationId: z.uuid(), agentId: z.uuid(),
  attempt: z.string().regex(/^backup-attempt-[a-f0-9-]{36}$/), result: measurementSchema });
const receiptSchema = measurementSchema.extend({ schemaVersion: z.literal(1), operationId: z.uuid(), agentId: z.uuid(), backupPath: z.string() }).strict();
export type PersonalMemoryBackupReceipt = z.infer<typeof receiptSchema>;
export interface PersonalMemoryBackupFailure { stage: string; error: unknown }
export class PersonalMemoryBackupFault extends Error {
  readonly code = 'personal_memory_backup_failed';
  constructor(readonly stage: string, readonly publication: FilePublication, readonly errors: readonly PersonalMemoryBackupFailure[],
    readonly workerExit?: { code: number | null; signal: string | null; observed: boolean; pid: number | null }) {
    super(`personal_memory_backup_${stage}`, errors.length ? { cause: errors[0]!.error } : undefined);
  }
}
export const backupWorkerRequestSchema = z.strictObject({ mode: z.enum(['create', 'verify']), intent: intentSchema,
  operationDirectory: z.string(), operationIdentity: identitySchema, targetPath: z.string(), targetIdentity: identitySchema,
  targetDirectoryIdentity: identitySchema, forbiddenRoots: z.array(z.string()), expected: measurementSchema.optional() });
export type BackupWorkerRequest = z.infer<typeof backupWorkerRequestSchema>;
const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const fileIdentity = (stat: Stats) => ({ volume: String(stat.dev), object: String(stat.ino) });
const fail = (code: string): never => { throw new Error(`personal_memory_backup_${code}`); };

/** Metadata only: never opens a raw descriptor on a SQLite source. */
export function backupFileIdentity(path: string, expected?: FileIdentity, links = 1): FileIdentity {
  if (process.platform === 'win32') {
    if (links !== 1) return fail('file_unsafe');
    return windowsBackupIdentity(path, expected);
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== links || (stat.mode & 0o077) !== 0 ||
    typeof process.getuid !== 'function' || stat.uid !== process.getuid()) fail('file_unsafe');
  const identity = fileIdentity(stat);
  if (expected && !sameFileIdentity(identity, expected)) fail('file_changed');
  return identity;
}
export function backupFileSize(path: string): number {
  const size = process.platform === 'win32' ? Number(windowsBackupInfo(path).bytes) : lstatSync(path).size;
  if (!Number.isSafeInteger(size) || size < 0) return fail('file_unsafe');
  return size;
}
function syncBackupDirectory(directory: MetadataDirectory) { completeMetadataPublication(hostMetadataFiles(), directory); }
function backupNames(path: string, directory: MetadataDirectory) {
  return process.platform === 'win32' ? windowsProfileFiles().names(directory, 65536) : readdirSync(path);
}
function optionalIdentity(path: string): FileIdentity | null {
  try { return backupFileIdentity(path); } catch (error) { if (errno(error) === 'ENOENT') return null; throw error; }
}
function reserveAttempt(scope: HostFileMutationScope, root: string, operationId: string) {
  // Four deterministic UUID-shaped slots keep concurrent callers from allocating an unbounded fifth attempt.
  for (let slot = 0; slot < personalMemoryBackupLimits.attempts; slot++) {
    const hash = createHash('sha256').update(`${operationId}/${slot}`).digest('hex');
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const attempt = `backup-attempt-${id}`, path = join(root, attempt);
    try { return { attempt, path, directory: scope.directory(path, 'private', true, true)! }; }
    catch (error) {
      if (!(error instanceof FileMutationFault && error.operation === 'directory' && error.status.created === false && errno(error.cause) === 'EEXIST') && errno(error) !== 'EEXIST') throw error;
    }
  }
  return fail('attempt_limit');
}
export function assertBackupSnapshot(snapshot: PersonalMemorySnapshot, intent: Pick<Intent,
  'agentId' | 'expectedSnapshotDigest' | 'expectedOwnerDigest' | 'expectedWorkDigest'>) {
  if (snapshot.agentId !== intent.agentId || snapshot.snapshotDigest !== intent.expectedSnapshotDigest ||
    snapshot.ownerDigest !== intent.expectedOwnerDigest || snapshot.workDigest !== intent.expectedWorkDigest) fail('snapshot_changed');
}
/** Only call after every SQLite handle for this candidate has closed. Fixed-size reads bound memory. */
export function hashAndSyncBackup(path: string, expected: FileIdentity, guard: () => void, deadline = Infinity) {
  if (process.platform === 'win32') return hashAndSyncWindowsBackup(path, expected, guard, deadline);
  guard(); backupFileIdentity(path, expected); const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let primary: unknown, result: { sha256: string; byteLength: number } | undefined;
  try {
    const before = fstatSync(fd, { bigint: true });
    if (String(before.dev) !== expected.volume || String(before.ino) !== expected.object || before.size > BigInt(personalMemoryBackupLimits.bytes) ||
      !before.isFile() || before.nlink !== 1n || (before.mode & 0o077n) !== 0n || before.uid !== BigInt(process.getuid!())) fail('file_changed');
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024); let count = 0;
    for (;;) {
      if (performance.now() > deadline) fail('deadline');
      const bytes = readSync(fd, buffer, 0, buffer.length, null); if (!bytes) break;
      count += bytes; if (count > personalMemoryBackupLimits.bytes) fail('capacity'); hash.update(buffer.subarray(0, bytes));
    }
    const after = fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || count !== Number(after.size)) fail('file_changed');
    fsyncSync(fd); guard(); backupFileIdentity(path, expected);
    const named = lstatSync(path, { bigint: true });
    if (named.size !== before.size || named.mtimeNs !== before.mtimeNs || named.ctimeNs !== before.ctimeNs) fail('file_changed');
    result = { sha256: hash.digest('hex'), byteLength: count };
  } catch (error) { primary = error; }
  try { closeSync(fd); } catch (error) {
    if (primary !== undefined) throw new PersonalMemoryBackupFault('hash_close', 'not_published', [{ stage: 'hash', error: primary }, { stage: 'close', error }]);
    throw error;
  }
  if (primary !== undefined) throw primary;
  return result!;
}
function readJson<T>(directory: MetadataDirectory, leaf: string, schema: z.ZodType<T>): T | null {
  try { return schema.parse(JSON.parse(readJsonBytes(directory, leaf).toString('utf8'))); }
  catch (error) { if (error instanceof FileBoundaryFault && error.code === 'missing') return null; throw error; }
}
function readJsonBytes(directory: MetadataDirectory, leaf: string) {
  return hostMetadataFiles().readStableRegularFile(directory, leaf, { maximum: 2 * 1024 * 1024, access: 'private',
    allowLinkedFile: (file, siblings) => {
      if (file.links !== 2n) return false;
      for (const name of siblings.names()) {
        if (!/^\.secumon-init-[a-f0-9-]{36}\.pending$/.test(name)) continue;
        const candidate = siblings.inspect(name);
        if (candidate?.kind === 'regular' && candidate.ownedByCaller && candidate.private && candidate.links === 2n &&
          candidate.size === file.size && sameFileIdentity(file.identity, candidate.identity)) return true;
      }
      return false;
    } });
}
function publishJson(scope: HostFileMutationScope, directory: MetadataDirectory, leaf: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > 2 * 1024 * 1024) fail('metadata_capacity');
  scope.publish(directory, leaf, bytes);
  const actual = readJsonBytes(directory, leaf);
  if (!actual.equals(bytes)) fail('publication_conflict');
}
interface RemoteError { name: string; message: string; code?: string; errcode?: number; cause?: RemoteError; errors?: { stage: string; error: RemoteError }[] }
export function serializeBackupError(error: unknown, depth = 0): RemoteError {
  const value = error as Error & { code?: string; errcode?: number; errors?: readonly unknown[] };
  return { name: value?.name ?? 'Error', message: String(value?.message ?? error).slice(0, 4096),
    ...(typeof value?.code === 'string' ? { code: value.code } : {}), ...(typeof value?.errcode === 'number' ? { errcode: value.errcode } : {}),
    ...(depth < 6 && value?.cause !== undefined ? { cause: serializeBackupError(value.cause, depth + 1) } : {}),
    ...(depth < 6 && Array.isArray(value?.errors) ? { errors: value.errors.slice(0, 12).map((item: unknown, index: number) => {
      const entry = item as Partial<PersonalMemoryBackupFailure> | null;
      return entry && typeof entry === 'object' && typeof entry.stage === 'string' && 'error' in entry ?
        { stage: entry.stage, error: serializeBackupError(entry.error, depth + 1) } :
        { stage: `aggregate_${index}`, error: serializeBackupError(item, depth + 1) };
    }) } : {}) };
}
function remoteError(value: RemoteError): Error {
  const result = new Error(value.message, value.cause ? { cause: remoteError(value.cause) } : undefined); result.name = value.name;
  return Object.assign(result, { ...(value.code ? { code: value.code } : {}), ...(value.errcode === undefined ? {} : { errcode: value.errcode }),
    ...(value.errors ? { errors: value.errors.map(item => ({ stage: item.stage, error: remoteError(item.error) })) } : {}) });
}
function unobservedWorker(error: unknown): PersonalMemoryBackupFault | null {
  if (!(error instanceof PersonalMemoryBackupFault)) return null;
  if (error.workerExit?.observed === false) return error;
  for (const failure of error.errors) { const found = unobservedWorker(failure.error); if (found) return found; }
  return null;
}
async function runWorker(request: BackupWorkerRequest): Promise<Measurement> {
  return new Promise((resolveResult, reject) => {
    const child = fork(new URL('./personal-memory-backup-worker.js', import.meta.url), [], { execPath: process.execPath,
      execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let reply: { result?: unknown; error?: RemoteError } | undefined, termination: unknown, output = 0;
    const failures: PersonalMemoryBackupFailure[] = []; let killTimer: NodeJS.Timeout | undefined, observeTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const terminate = (error: unknown) => {
      if (termination !== undefined) return; termination = error;
      try { child.kill('SIGTERM'); } catch (cause) { failures.push({ stage: 'terminate', error: cause }); }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (cause) { failures.push({ stage: 'kill', error: cause }); }
        observeTimer = setTimeout(() => {
          if (settled) return; settled = true; clearTimeout(timer);
          failures.unshift({ stage: 'deadline', error: termination });
          failures.push({ stage: 'exit_observation', error: new Error('personal_memory_backup_worker_exit_unobserved') });
          child.unref(); child.stdout?.destroy(); child.stderr?.destroy();
          try { if (child.connected) child.disconnect(); } catch (error) { failures.push({ stage: 'disconnect', error }); }
          reject(new PersonalMemoryBackupFault('worker_exit_unobserved', 'not_published', failures,
            { code: null, signal: null, observed: false, pid: child.pid ?? null }));
        }, 5000);
      }, 5000);
    };
    const timer = setTimeout(() => terminate(new Error('personal_memory_backup_deadline')), personalMemoryBackupLimits.workerMs);
    const data = (chunk: Buffer) => { output += chunk.length; if (output > 64 * 1024) terminate(new Error('personal_memory_backup_worker_output_limit')); };
    child.stdout?.on('data', data); child.stderr?.on('data', data);
    child.on('error', error => { failures.push({ stage: 'worker', error }); });
    child.on('message', message => {
      if (reply || Buffer.byteLength(JSON.stringify(message)) > 4 * 1024 * 1024) { terminate(new Error('personal_memory_backup_worker_protocol')); return; }
      reply = message as { result?: unknown; error?: RemoteError };
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer); if (observeTimer) clearTimeout(observeTimer);
      if (settled) return; settled = true;
      try {
        if (termination !== undefined) failures.unshift({ stage: 'deadline', error: termination });
        if (reply?.error) failures.unshift({ stage: 'worker', error: remoteError(reply.error) });
        if (code !== 0 || signal || !reply?.result || failures.length) throw new PersonalMemoryBackupFault('worker', 'not_published',
          failures.length ? failures : [{ stage: 'worker', error: new Error('personal_memory_backup_worker_exit') }], { code, signal, observed: true, pid: child.pid ?? null });
        resolveResult(measurementSchema.parse(reply.result));
      } catch (error) { reject(error); }
    });
    child.send(request, error => { if (error) terminate(error); });
  });
}

/** Host-only SQLite snapshot publication. Existing canonical files are never passed to backup(). */
export async function createOrResumePersonalMemoryBackup(input: PersonalMemoryBackupOptions): Promise<PersonalMemoryBackupReceipt> {
  const options = optionsSchema.parse(input), root = resolve(options.operationDirectory), source = resolve(options.sourcePath);
  const scope = hostFileMutations().openScope({ root, forbiddenRoots: [...options.forbiddenRoots, dirname(source)] });
  const errors: PersonalMemoryBackupFailure[] = []; let publication: FilePublication = 'not_published', stage = 'intent';
  let sourceScope: HostFileMutationScope | undefined, cleanupLinked: (() => void) | undefined, syncCandidate: (() => void) | undefined;
  let result: PersonalMemoryBackupReceipt | undefined;
  try {
    const directory = scope.directory(root, 'private', true)!;
    if (readJson(directory, 'backup-worker-unobserved.json', z.unknown()) !== null) fail('worker_cleanup_required');
    sourceScope = hostFileMutations().openScope({ root: dirname(source), forbiddenRoots: options.forbiddenRoots });
    const sourceDirectory = sourceScope.directory(dirname(source), 'private') ?? fail('source_missing');
    const saved = readJson(directory, 'backup-intent.json', intentSchema);
    const intent: Intent = { schemaVersion: 1, operationId: options.operationId, agentId: options.agentId,
      sourcePath: source, sourceIdentity: backupFileIdentity(source, saved?.sourceIdentity), sourceDirectoryIdentity: sourceDirectory.identity,
      expectedSnapshotDigest: options.expectedSnapshotDigest,
      expectedOwnerDigest: options.expectedOwnerDigest, expectedWorkDigest: options.expectedWorkDigest };
    if (saved && !isDeepStrictEqual(saved, intent)) fail('intent_conflict');
    if (!saved) publishJson(scope, directory, 'backup-intent.json', intent);
    const finalPath = join(root, 'backup.sqlite');
    const completed = readJson(directory, 'backup-complete.json', receiptSchema);
    let verified: z.infer<typeof verifiedSchema> | null = null;
    const names = backupNames(root, directory), attempts = names.filter(name => /^backup-attempt-[a-f0-9-]{36}$/.test(name)).sort();
    if (attempts.length > personalMemoryBackupLimits.attempts) fail('attempt_limit');
    const selectVerified = () => {
      const currentAttempts = backupNames(root, directory).filter(name => /^backup-attempt-[a-f0-9-]{36}$/.test(name)).sort();
      if (currentAttempts.length > personalMemoryBackupLimits.attempts) fail('attempt_limit');
      const candidates: z.infer<typeof verifiedSchema>[] = [];
      for (const attempt of currentAttempts) {
        const candidate = readJson(directory, `backup-verified-${attempt.slice('backup-attempt-'.length)}.json`, verifiedSchema);
        if (candidate) {
          if (candidate.attempt !== attempt || candidate.operationId !== intent.operationId || candidate.agentId !== intent.agentId) fail('verified_conflict');
          assertBackupSnapshot(candidate.result.snapshot, intent); candidates.push(candidate);
        }
      }
      let finalIdentity: FileIdentity | null = null;
      try { finalIdentity = process.platform === 'win32' ? backupFileIdentity(finalPath) : fileIdentity(lstatSync(finalPath)); }
      catch (error) { if (errno(error) !== 'ENOENT') throw error; }
      if (finalIdentity) return candidates.find(candidate => sameFileIdentity(candidate.result.identity, finalIdentity!)) ?? fail('unverified_publication');
      return candidates[0] ?? null;
    };
    if (completed) {
      publication = 'published';
      if (completed.operationId !== intent.operationId || completed.agentId !== intent.agentId || completed.backupPath !== finalPath) fail('receipt_conflict');
      assertBackupSnapshot(completed.snapshot, intent); backupFileIdentity(finalPath, completed.identity);
    }
    verified = selectVerified();
    if (completed) {
      if (!verified || !sameFileIdentity(verified.result.identity, completed.identity)) fail('verified_missing');
    }
    if (!verified) {
      if (completed || optionalIdentity(finalPath)) fail('unverified_publication');
      if (attempts.length >= personalMemoryBackupLimits.attempts) fail('attempt_limit');
      stage = 'candidate'; const reserved = reserveAttempt(scope, root, intent.operationId), attempt = reserved.attempt, attemptPath = reserved.path;
      const attemptDirectory = reserved.directory, candidatePath = join(attemptPath, 'candidate.sqlite');
      if (process.platform === 'win32') {
        const reservedFile = scope.publish(attemptDirectory, 'candidate.sqlite', Buffer.alloc(0));
        if (!reservedFile.published) fail('candidate_exists');
      } else {
        const fd = openSync(candidatePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        let reserveError: unknown;
        try { fsyncSync(fd); } catch (error) { reserveError = error; }
        try { closeSync(fd); } catch (error) { if (reserveError !== undefined) errors.push({ stage: 'candidate_sync', error: reserveError }); throw error; }
        if (reserveError !== undefined) throw reserveError;
      }
      const identity = backupFileIdentity(candidatePath); scope.check(); syncBackupDirectory(attemptDirectory);
      stage = 'copy'; const measurement = await runWorker({ mode: 'create', intent, operationDirectory: root,
        operationIdentity: directory.identity, targetPath: candidatePath, targetIdentity: identity,
        targetDirectoryIdentity: attemptDirectory.identity, forbiddenRoots: options.forbiddenRoots });
      scope.check(); sourceScope.check(); backupFileIdentity(source, intent.sourceIdentity);
      backupFileIdentity(candidatePath, identity); assertBackupSnapshot(measurement.snapshot, intent);
      verified = { schemaVersion: 1, operationId: intent.operationId, agentId: intent.agentId, attempt, result: measurement };
      stage = 'verified'; publishJson(scope, directory, `backup-verified-${attempt.slice('backup-attempt-'.length)}.json`, verified);
      verified = selectVerified() ?? fail('verified_missing');
    }
    const attemptPath = join(root, verified.attempt), candidatePath = join(attemptPath, 'candidate.sqlite');
    const attemptDirectory = scope.directory(attemptPath, 'private') ?? fail('candidate_directory_missing');
    syncCandidate = () => { scope.check(); syncBackupDirectory(attemptDirectory); };
    const verifiedIdentity = verified.result.identity;
    cleanupLinked = () => {
      if (process.platform === 'win32') {
        // Rename consumes the candidate. An ambiguous outcome is retained, never guessed from a second path.
        scope.check(); const current = optionalIdentity(finalPath);
        if (current && !sameFileIdentity(current, verifiedIdentity)) fail('file_changed');
        return;
      }
      scope.check(); const finalStat = lstatSync(finalPath);
      if (finalStat.nlink === 1) { backupFileIdentity(finalPath, verifiedIdentity); return; }
      backupFileIdentity(finalPath, verifiedIdentity, 2); backupFileIdentity(candidatePath, verifiedIdentity, 2);
      unlinkSync(candidatePath);
    };
    let finalExists = false;
    try { if (process.platform === 'win32') backupFileIdentity(finalPath); else lstatSync(finalPath); finalExists = true; }
    catch (error) { if (errno(error) !== 'ENOENT') throw error; }
    if (finalExists) {
      const stat = process.platform === 'win32' ? null : lstatSync(finalPath);
      if (stat?.nlink === 2) {
        backupFileIdentity(finalPath, verified.result.identity, 2); backupFileIdentity(candidatePath, verified.result.identity, 2);
        publication = 'published';
        stage = 'linked_cleanup'; scope.check(); unlinkSync(candidatePath); syncBackupDirectory(attemptDirectory);
      }
      backupFileIdentity(finalPath, verified.result.identity); publication = 'published';
    } else {
      stage = 'verify_candidate'; backupFileIdentity(candidatePath, verified.result.identity);
      const checked = await runWorker({ mode: 'verify', intent, operationDirectory: root, operationIdentity: directory.identity,
        targetPath: candidatePath, targetIdentity: verified.result.identity, targetDirectoryIdentity: attemptDirectory.identity,
        forbiddenRoots: options.forbiddenRoots, expected: verified.result });
      if (!isDeepStrictEqual(checked, verified.result)) fail('verified_changed');
      scope.check(); backupFileIdentity(candidatePath, verified.result.identity); stage = 'link'; publication = 'unknown';
      if (process.platform === 'win32') {
        stage = 'rename';
        try { publication = publishWindowsBackup(attemptDirectory, directory, verified.result.identity).publication; }
        catch (error) {
          if (error instanceof FileMutationFault) publication = error.status.publication;
          try { backupFileIdentity(finalPath, verified.result.identity); publication = 'published'; } catch { /* Preserve the native ambiguous outcome. */ }
          throw error;
        }
        scope.check(); backupFileIdentity(finalPath, verified.result.identity);
        syncBackupDirectory(attemptDirectory); syncBackupDirectory(directory);
      } else {
        try { linkSync(candidatePath, finalPath); publication = 'published'; }
        catch (error) {
          if (['EEXIST', 'EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOTDIR', 'EXDEV'].includes(errno(error) ?? '')) publication = 'not_published';
          try { backupFileIdentity(finalPath, verified.result.identity, 2); publication = 'published'; } catch { /* Ambiguous link remains unknown. */ }
          throw error;
        }
        syncBackupDirectory(directory); stage = 'linked_cleanup'; scope.check();
        backupFileIdentity(finalPath, verified.result.identity, 2); backupFileIdentity(candidatePath, verified.result.identity, 2);
        unlinkSync(candidatePath); syncBackupDirectory(attemptDirectory); syncBackupDirectory(directory);
      }
    }
    stage = 'verify_final'; const final = await runWorker({ mode: 'verify', intent, operationDirectory: root,
      operationIdentity: directory.identity, targetPath: finalPath, targetIdentity: verified.result.identity,
      targetDirectoryIdentity: directory.identity, forbiddenRoots: options.forbiddenRoots, expected: verified.result });
    if (!isDeepStrictEqual(final, verified.result)) fail('verified_changed');
    scope.check(); backupFileIdentity(finalPath, verified.result.identity); syncBackupDirectory(directory);
    result = { schemaVersion: 1, operationId: intent.operationId, agentId: intent.agentId, backupPath: finalPath, ...final };
    if (completed && !isDeepStrictEqual(completed, result)) fail('receipt_conflict');
    stage = 'receipt'; publishJson(scope, directory, 'backup-complete.json', result);
    scope.check(); sourceScope.check(); backupFileIdentity(source, intent.sourceIdentity); backupFileIdentity(finalPath, result.identity);
  } catch (error) { errors.push({ stage, error }); }
  if (errors.length) {
    const uncertain = errors.map(failure => unobservedWorker(failure.error)).find(Boolean);
    if (uncertain) {
      try {
        scope.check(); const directory = scope.directory(root, 'private');
        if (directory) publishJson(scope, directory, 'backup-worker-unobserved.json', { schemaVersion: 1,
          operationId: options.operationId, workerExit: uncertain.workerExit, error: serializeBackupError(uncertain) });
      } catch (error) { errors.push({ stage: 'unobserved_receipt', error }); }
    }
    // Only a matching final/candidate pair may be cleaned. Each barrier is attempted independently.
    if (publication !== 'not_published' && cleanupLinked) {
      try { cleanupLinked(); } catch (error) { errors.push({ stage: 'failure_cleanup', error }); }
      try { syncCandidate?.(); } catch (error) { errors.push({ stage: 'failure_candidate_sync', error }); }
    }
    try { scope.check(); const directory = scope.directory(root, 'private'); if (directory) syncBackupDirectory(directory); }
    catch (error) { errors.push({ stage: 'failure_sync', error }); }
  }
  try { sourceScope?.close(); } catch (error) { errors.push({ stage: 'source_scope_close', error }); }
  try { scope.close(); } catch (error) { errors.push({ stage: 'close', error }); }
  if (errors.length) throw new PersonalMemoryBackupFault(stage, publication, errors);
  return result!;
}
