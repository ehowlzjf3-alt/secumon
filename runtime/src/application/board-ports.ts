import type { BoardActor, BoardState, BoardChangePage, BoardChangeQuery } from '../domain/board.js';

export interface BoardActorProvider { current(): Promise<BoardActor> }
export interface BoardCommit { expectedRevision: number; commandId: string; commandDigest: string; next: BoardState;
  /** A durable no-op closes this command identity against a late competing commit. */
  disposition?: 'not_applied' | undefined }
export interface BoardReceipt { digest: string; revision: number; disposition?: 'not_applied' | undefined }
export type BoardCommitResult = { kind: 'committed' | 'duplicate'; revision: number } |
  { kind: 'not_applied'; revision: number } | { kind: 'conflict'; actualRevision: number } | { kind: 'idempotency_conflict' };
export interface BoardRepository {
  get(tenantId: string, id: string): Promise<BoardState | null>;
  receipt(tenantId: string, id: string, commandId: string): Promise<BoardReceipt | null>;
  commit(command: BoardCommit): Promise<BoardCommitResult>;
  changes?(tenantId: string, id: string, query: BoardChangeQuery): Promise<BoardChangePage>;
  close(): Promise<void>;
}
