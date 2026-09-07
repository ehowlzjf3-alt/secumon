import type { DatabaseSync } from 'node:sqlite';
import { openHostSqliteDatabase, closeSqliteAfterFailure } from './windows-sqlite.js';
import type { BoardCommit, BoardCommitResult, BoardRepository } from '../application/board-ports.js';
import { BoardStateSchema } from '../application/board-contracts.js';
import { validateBoardCommit, validateBoardCommand } from '../application/board-store-contract.js';
import { boardChange, type BoardChangeQuery } from '../domain/board.js';
import { boardChangePage, BoardChangeQuerySchema, BoardChangeSchema } from '../application/board-change-contracts.js';

export class SqliteBoardRepository implements BoardRepository {
  readonly #db: DatabaseSync;
  constructor(path: string) {
    this.#db = openHostSqliteDatabase(path);
    try { this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS boards_v1 (tenant_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(tenant_id,id));
      CREATE TABLE IF NOT EXISTS board_receipts_v1 (tenant_id TEXT NOT NULL, id TEXT NOT NULL, command_id TEXT NOT NULL,
        digest TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(tenant_id,id,command_id));
      CREATE TABLE IF NOT EXISTS board_closed_commands_v1 (tenant_id TEXT NOT NULL, id TEXT NOT NULL, command_id TEXT NOT NULL,
        PRIMARY KEY(tenant_id,id,command_id));
      CREATE TABLE IF NOT EXISTS board_event_roots_v1 (tenant_id TEXT NOT NULL, id TEXT NOT NULL, after_revision INTEGER NOT NULL, PRIMARY KEY(tenant_id,id));
      CREATE TABLE IF NOT EXISTS board_events_v1 (tenant_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(tenant_id,id,revision));
      INSERT INTO board_event_roots_v1(tenant_id,id,after_revision) SELECT tenant_id,id,revision FROM boards_v1 WHERE 1
        ON CONFLICT(tenant_id,id) DO NOTHING;`); }
    catch (error) { closeSqliteAfterFailure(this.#db, error); }
  }
  async get(tenantId: string, id: string) {
    const row = this.#db.prepare('SELECT body FROM boards_v1 WHERE tenant_id=? AND id=?').get(tenantId, id);
    return row ? BoardStateSchema.parse(JSON.parse(String(row['body']))) : null;
  }
  async receipt(tenantId: string, id: string, commandId: string) {
    const row = this.#db.prepare('SELECT digest,revision FROM board_receipts_v1 WHERE tenant_id=? AND id=? AND command_id=?').get(tenantId, id, commandId);
    const closed = row && this.#db.prepare('SELECT command_id FROM board_closed_commands_v1 WHERE tenant_id=? AND id=? AND command_id=?').get(tenantId, id, commandId);
    return row ? { digest: String(row['digest']), revision: Number(row['revision']), ...(closed ? { disposition: 'not_applied' as const } : {}) } : null;
  }
  async commit(input: BoardCommit): Promise<BoardCommitResult> {
    const command = validateBoardCommit(input), next = command.next;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const receipt = this.#db.prepare('SELECT digest,revision FROM board_receipts_v1 WHERE tenant_id=? AND id=? AND command_id=?').get(next.tenantId, next.id, command.commandId);
      if (receipt) {
        const closed = this.#db.prepare('SELECT command_id FROM board_closed_commands_v1 WHERE tenant_id=? AND id=? AND command_id=?').get(next.tenantId, next.id, command.commandId);
        this.#db.exec('ROLLBACK'); return receipt['digest'] === command.commandDigest ? { kind: closed ? 'not_applied' : 'duplicate', revision: Number(receipt['revision']) } : { kind: 'idempotency_conflict' };
      }
      const row = this.#db.prepare('SELECT body FROM boards_v1 WHERE tenant_id=? AND id=?').get(next.tenantId, next.id);
      const prior = row ? BoardStateSchema.parse(JSON.parse(String(row['body']))) : null;
      if ((prior?.revision ?? 0) !== command.expectedRevision) { this.#db.exec('ROLLBACK'); return { kind: 'conflict', actualRevision: prior?.revision ?? 0 }; }
      validateBoardCommand(prior, command);
      this.#db.prepare('INSERT INTO boards_v1(tenant_id,id,revision,body) VALUES(?,?,?,?) ON CONFLICT(tenant_id,id) DO UPDATE SET revision=excluded.revision,body=excluded.body')
        .run(next.tenantId, next.id, next.revision, JSON.stringify(next));
      this.#db.prepare('INSERT INTO board_receipts_v1(tenant_id,id,command_id,digest,revision) VALUES(?,?,?,?,?)')
        .run(next.tenantId, next.id, command.commandId, command.commandDigest, next.revision);
      if (command.disposition) this.#db.prepare('INSERT INTO board_closed_commands_v1(tenant_id,id,command_id) VALUES(?,?,?)').run(next.tenantId, next.id, command.commandId);
      this.#db.prepare('INSERT INTO board_event_roots_v1(tenant_id,id,after_revision) VALUES(?,?,?) ON CONFLICT(tenant_id,id) DO NOTHING').run(next.tenantId, next.id, prior?.revision ?? 0);
      this.#db.prepare('INSERT INTO board_events_v1(tenant_id,id,revision,body) VALUES(?,?,?,?)').run(next.tenantId, next.id, next.revision, JSON.stringify(boardChange(prior, next)));
      this.#db.exec('COMMIT'); return { kind: command.disposition ? 'not_applied' : 'committed', revision: next.revision };
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  async changes(tenantId: string, id: string, query: BoardChangeQuery) {
    const args = BoardChangeQuerySchema.parse(query);
    this.#db.exec('BEGIN');
    try {
      const row = this.#db.prepare('SELECT revision FROM boards_v1 WHERE tenant_id=? AND id=?').get(tenantId, id);
      const root = this.#db.prepare('SELECT after_revision FROM board_event_roots_v1 WHERE tenant_id=? AND id=?').get(tenantId, id);
      if (!row || !root) throw new Error('board_events_unavailable');
      const events = this.#db.prepare('SELECT body FROM board_events_v1 WHERE tenant_id=? AND id=? AND revision>? ORDER BY revision LIMIT ?')
        .all(tenantId, id, args.afterRevision, args.maxEvents + 1).map(value => BoardChangeSchema.parse(JSON.parse(String(value['body']))));
      const page = boardChangePage(args, Number(row['revision']), Number(root['after_revision']), events);
      this.#db.exec('COMMIT'); return page;
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  async close() { this.#db.close(); }
}
