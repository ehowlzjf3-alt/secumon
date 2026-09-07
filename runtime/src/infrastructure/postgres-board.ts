import type { BoardCommit, BoardCommitResult, BoardRepository } from '../application/board-ports.js';
import { BoardStateSchema } from '../application/board-contracts.js';
import { validateBoardCommit, validateBoardCommand } from '../application/board-store-contract.js';
import { boardChange, type BoardChangeQuery } from '../domain/board.js';
import { boardChangePage, BoardChangeQuerySchema, BoardChangeSchema } from '../application/board-change-contracts.js';
import { PostgresStore, postgresInteger, postgresJson } from './postgres-store.js';

export const POSTGRES_BOARD_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS secumon_pg.boards(store_id text NOT NULL,agent_id text NOT NULL,tenant_id text NOT NULL,id text NOT NULL,
    revision bigint NOT NULL,body text NOT NULL,PRIMARY KEY(store_id,agent_id,tenant_id,id))`,
  `CREATE TABLE IF NOT EXISTS secumon_pg.board_receipts(store_id text NOT NULL,agent_id text NOT NULL,tenant_id text NOT NULL,id text NOT NULL,
    command_id text NOT NULL,digest text NOT NULL,revision bigint NOT NULL,closed boolean NOT NULL,PRIMARY KEY(store_id,agent_id,tenant_id,id,command_id))`,
  `CREATE TABLE IF NOT EXISTS secumon_pg.board_roots(store_id text NOT NULL,agent_id text NOT NULL,tenant_id text NOT NULL,id text NOT NULL,
    after_revision bigint NOT NULL,PRIMARY KEY(store_id,agent_id,tenant_id,id))`,
  `CREATE TABLE IF NOT EXISTS secumon_pg.board_events(store_id text NOT NULL,agent_id text NOT NULL,tenant_id text NOT NULL,id text NOT NULL,
    revision bigint NOT NULL,body text NOT NULL,PRIMARY KEY(store_id,agent_id,tenant_id,id,revision))`,
];
const where = 'store_id=$1 AND agent_id=$2 AND tenant_id=$3 AND id=$4';
export class PostgresBoardRepository implements BoardRepository {
  constructor(private readonly store: PostgresStore) { if (store.binding.purpose !== 'board') throw new Error('postgres_board_binding_required'); }
  async get(tenantId: string, id: string) {
    return this.store.read(async c => {
      const row = (await c.query(`SELECT body FROM secumon_pg.boards WHERE ${where}`, [...this.store.key, tenantId, id])).rows[0];
      const board = row ? BoardStateSchema.parse(postgresJson(row['body'])) : null;
      if (board && (board.id !== id || board.tenantId !== tenantId)) throw new Error('invalid_board_storage');
      return board;
    });
  }
  async receipt(tenantId: string, id: string, commandId: string) {
    return this.store.read(async c => {
      const row = (await c.query(`SELECT digest,revision,closed FROM secumon_pg.board_receipts WHERE ${where} AND command_id=$5`, [...this.store.key, tenantId, id, commandId])).rows[0];
      if (!row) return null;
      if (typeof row['digest'] !== 'string' || typeof row['closed'] !== 'boolean') throw new Error('invalid_board_storage');
      return { digest: row['digest'], revision: postgresInteger(row['revision']), ...(row['closed'] ? { disposition: 'not_applied' as const } : {}) };
    });
  }
  async commit(raw: BoardCommit): Promise<BoardCommitResult> {
    const command = validateBoardCommit(structuredClone(raw)), next = command.next, key = [...this.store.key, next.tenantId, next.id];
    return this.store.write(async c => {
      const receipt = (await c.query(`SELECT digest,revision,closed FROM secumon_pg.board_receipts WHERE ${where} AND command_id=$5`, [...key, command.commandId])).rows[0];
      if (receipt) return receipt['digest'] === command.commandDigest ? { kind: receipt['closed'] ? 'not_applied' : 'duplicate', revision: postgresInteger(receipt['revision']) } : { kind: 'idempotency_conflict' };
      const row = (await c.query(`SELECT body FROM secumon_pg.boards WHERE ${where}`, key)).rows[0];
      const prior = row ? BoardStateSchema.parse(postgresJson(row['body'])) : null;
      if ((prior?.revision ?? 0) !== command.expectedRevision) return { kind: 'conflict', actualRevision: prior?.revision ?? 0 };
      validateBoardCommand(prior, command);
      await c.query(`INSERT INTO secumon_pg.boards VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(store_id,agent_id,tenant_id,id)
        DO UPDATE SET revision=excluded.revision,body=excluded.body`, [...key, next.revision, JSON.stringify(next)]);
      await c.query('INSERT INTO secumon_pg.board_receipts VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [...key, command.commandId, command.commandDigest, next.revision, command.disposition === 'not_applied']);
      await c.query('INSERT INTO secumon_pg.board_roots VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [...key, prior?.revision ?? 0]);
      await c.query('INSERT INTO secumon_pg.board_events VALUES($1,$2,$3,$4,$5,$6)', [...key, next.revision, JSON.stringify(boardChange(prior, next))]);
      return { kind: command.disposition ? 'not_applied' : 'committed', revision: next.revision };
    });
  }
  async changes(tenantId: string, id: string, raw: BoardChangeQuery) {
    const query = BoardChangeQuerySchema.parse(raw), key = [...this.store.key, tenantId, id];
    return this.store.read(async c => {
      const current = (await c.query(`SELECT revision FROM secumon_pg.boards WHERE ${where}`, key)).rows[0];
      const root = (await c.query(`SELECT after_revision FROM secumon_pg.board_roots WHERE ${where}`, key)).rows[0];
      if (!current || !root) throw new Error('board_events_unavailable');
      const changes = (await c.query(`SELECT body FROM secumon_pg.board_events WHERE ${where} AND revision>$5 ORDER BY revision LIMIT $6`, [...key, query.afterRevision, query.maxEvents + 1])).rows
        .map(row => BoardChangeSchema.parse(postgresJson(row['body'])));
      return boardChangePage(query, postgresInteger(current['revision']), postgresInteger(root['after_revision']), changes);
    });
  }
  close() { return this.store.close(); }
}
