import { constants, closeSync, existsSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BoardCommit, BoardCommitResult, BoardReceipt, BoardRepository } from '../application/board-ports.js';
import type { BoardState } from '../domain/board.js';
import { validateBoardCommit, validateBoardCommand } from '../application/board-store-contract.js';
import { sha256 } from './digest.js';
import { boardChange, type BoardChange, type BoardChangeQuery } from '../domain/board.js';
import { boardChangePage, BoardChangeQuerySchema } from '../application/board-change-contracts.js';
import { WindowsJournalFiles } from './windows-journal-files.js';
import { windowsProfileFiles } from './windows-profile-files.js';
import { publishWindowsFileSync } from './windows-stream-files.js';
import { FileMutationFault } from './host-file-mutations.js';

const recordSchema = z.strictObject({ kind: z.literal('board-journal-v1'), previous: z.string().nullable(),
  command: z.unknown(), checksum: z.string().regex(/^[a-f0-9]{64}$/) });
export interface FileBoardOptions { onPublished?: (() => void) | undefined }
export class FileBoardRepository implements BoardRepository {
  readonly #root: string; readonly #identity: { dev: number; ino: number } | undefined;
  readonly #windows: WindowsJournalFiles | undefined; #closed = false;
  constructor(directory: string, private readonly options: FileBoardOptions = {}) {
    this.#root = resolve(directory);
    if (process.platform === 'win32') {
      this.#windows = new WindowsJournalFiles(windowsProfileFiles(), this.#root);
      this.#root = this.#windows.root; this.#identity = undefined;
      return;
    }
    this.#windows = undefined;
    if (!existsSync(this.#root)) mkdirSync(this.#root, { mode: 0o700 });
    this.#identity = this.#directory(); this.#sync(); this.#sync(dirname(this.#root));
  }
  #directory() {
    if (this.#closed) throw new Error('board_store_closed');
    if (this.#windows) { this.#windows.check(); return; }
    const stat = lstatSync(this.#root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) ||
      (process.getuid && stat.uid !== process.getuid()) || (this.#identity && (stat.dev !== this.#identity.dev || stat.ino !== this.#identity.ino))) throw new Error('board_store_unsafe');
    return { dev: stat.dev, ino: stat.ino };
  }
  #sync(path = this.#root) { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
  #prefix(tenantId: string, id: string) { return sha256(JSON.stringify([tenantId, id])); }
  #read(path: string) {
    if (this.#windows) return this.#windows.read(path, 8 * 1024 * 1024).toString('utf8');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('board_record_unsafe');
      const bytes = readFileSync(fd); if (bytes.byteLength !== stat.size) throw new Error('board_record_changed'); return bytes.toString('utf8');
    } finally { closeSync(fd); }
  }
  #load(tenantId: string, id: string, includeChanges = false) {
    this.#directory(); const prefix = this.#prefix(tenantId, id);
    const files = (this.#windows ? this.#windows.names(this.#root) : readdirSync(this.#root))
      .filter(name => name.startsWith(`${prefix}-`) && name.endsWith('.json')).sort();
    if (files.length > 4096) throw new Error('board_journal_capacity');
    let state: BoardState | null = null, hash: string | null = null;
    const receipts = new Map<string, BoardReceipt>(), changes: BoardChange[] = [];
    for (let index = 0; index < files.length; index++) {
      const name = files[index]!; if (name !== `${prefix}-${String(index + 1).padStart(8, '0')}.json`) throw new Error('board_journal_gap');
      const bytes = this.#read(join(this.#root, name)), record = recordSchema.parse(JSON.parse(bytes));
      if (record.previous !== hash || record.checksum !== sha256(JSON.stringify({ kind: record.kind, previous: record.previous, command: record.command }))) throw new Error('board_journal_corrupt');
      const command = validateBoardCommit(record.command as BoardCommit);
      if (command.next.tenantId !== tenantId || command.next.id !== id || command.expectedRevision !== index || receipts.has(command.commandId)) throw new Error('board_journal_identity');
      validateBoardCommand(state, command); if (includeChanges) changes.push(boardChange(state, command.next)); state = command.next; hash = sha256(bytes);
      receipts.set(command.commandId, { digest: command.commandDigest, revision: state.revision, ...(command.disposition ? { disposition: command.disposition } : {}) });
    }
    this.#directory(); return { state, hash, receipts, changes };
  }
  async get(tenantId: string, id: string) { return this.#load(tenantId, id).state; }
  async receipt(tenantId: string, id: string, commandId: string) { return this.#load(tenantId, id).receipts.get(commandId) ?? null; }
  async changes(tenantId: string, id: string, query: BoardChangeQuery) {
    const args = BoardChangeQuerySchema.parse(query), loaded = this.#load(tenantId, id, true);
    if (!loaded.state) throw new Error('board_events_unavailable');
    return boardChangePage(args, loaded.state.revision, 0, loaded.changes.filter(value => value.revision > args.afterRevision).slice(0, args.maxEvents + 1));
  }
  async commit(input: BoardCommit): Promise<BoardCommitResult> {
    const command = validateBoardCommit(input), next = command.next, prior = this.#load(next.tenantId, next.id);
    const receipt = prior.receipts.get(command.commandId);
    if (receipt) return receipt.digest === command.commandDigest ? { kind: receipt.disposition ? 'not_applied' : 'duplicate', revision: receipt.revision } : { kind: 'idempotency_conflict' };
    if ((prior.state?.revision ?? 0) !== command.expectedRevision) return { kind: 'conflict', actualRevision: prior.state?.revision ?? 0 };
    if (next.revision > 4096) throw new Error('board_journal_capacity'); validateBoardCommand(prior.state, command);
    const base = { kind: 'board-journal-v1' as const, previous: prior.hash, command };
    const bytes = JSON.stringify({ ...base, checksum: sha256(JSON.stringify(base)) });
    if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw new Error('board_record_too_large');
    const path = join(this.#root, `${this.#prefix(next.tenantId, next.id)}-${String(next.revision).padStart(8, '0')}.json`);
    if (this.#windows) {
      this.#directory();
      const result = publishWindowsFileSync(this.#windows.files, this.#windows.directory, basename(path), Buffer.from(bytes));
      try { this.#directory(); }
      catch (error) { throw new FileMutationFault('publish', 'board_scope_check', result, [{ stage: 'board_scope_check', error }]); }
      if (!result.published) {
        const current = this.#load(next.tenantId, next.id), duplicate = current.receipts.get(command.commandId);
        return duplicate ? duplicate.digest === command.commandDigest ? { kind: duplicate.disposition ? 'not_applied' : 'duplicate', revision: duplicate.revision } : { kind: 'idempotency_conflict' } :
          { kind: 'conflict', actualRevision: current.state?.revision ?? 0 };
      }
      // The native publisher flushed the file; Windows has no namespace fsync barrier here.
      this.options.onPublished?.(); return { kind: command.disposition ? 'not_applied' : 'committed', revision: next.revision };
    }
    const candidate = join(this.#root, `.candidate-${randomUUID()}`), fd = openSync(candidate, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      this.#directory();
      try { linkSync(candidate, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const current = this.#load(next.tenantId, next.id), duplicate = current.receipts.get(command.commandId);
        return duplicate ? duplicate.digest === command.commandDigest ? { kind: duplicate.disposition ? 'not_applied' : 'duplicate', revision: duplicate.revision } : { kind: 'idempotency_conflict' } :
          { kind: 'conflict', actualRevision: current.state?.revision ?? 0 };
      }
      this.#sync(); this.options.onPublished?.(); return { kind: command.disposition ? 'not_applied' : 'committed', revision: next.revision };
    } finally { unlinkSync(candidate); }
  }
  async close() { if (this.#closed) return; this.#closed = true; this.#windows?.close(); }
}
