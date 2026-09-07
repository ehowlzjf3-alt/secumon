import type { KnowledgeDependency } from './knowledge.js';
import type { ArtifactRef, Evidence, Json, ToolUsage } from './model.js';

export interface ReadKey { id: string; inputDigest: string }
export interface ReadItem extends ReadKey {
  status: 'success' | 'partial' | 'error' | 'not_run';
  output: Json;
  evidence: Evidence[];
  artifacts: ArtifactRef[];
  coverage: 'complete' | 'partial' | 'unknown';
  error: { code: string; retryable: boolean } | null;
  retryAt?: number | undefined;
}
export interface ReadRequest {
  requestId: string;
  cursor: string | null;
  snapshot: string | null;
  retryItems: ReadKey[] | null;
  itemLimit: number;
}
export interface ReadPage {
  requestId: string;
  sourceSnapshot: string;
  cursor: string | null;
  nextCursor: string | null;
  exhausted: boolean;
  totalItems: number | null;
  expected: ReadKey[];
  items: ReadItem[];
  /** Original response for this individual received page; merged collection pages may contain earlier responses too. */
  rawArtifact?: ArtifactRef | undefined;
  usage?: ToolUsage | undefined;
  knowledgeDependencies?: KnowledgeDependency[] | undefined;
}
export interface ReadLimits {
  maxPages: number;
  maxItems: number;
  maxCalls: number;
  maxPageBytes: number;
  maxCheckpointBytes: number;
  pageSize: number;
}
/** A received retry barrier, not an accepted data page or an observation. */
export interface ReadDeferral {
  kind: 'read_deferral'; requestId: string; dueAt: number; reason: 'rate_limited';
  rawArtifact?: ArtifactRef | undefined;
  usage?: ToolUsage | undefined;
  knowledgeDependencies?: KnowledgeDependency[] | undefined;
}
export type ReadResponse = ReadPage | ReadDeferral;
export function isReadDeferral(response: ReadResponse): response is ReadDeferral { return 'kind' in response && response.kind === 'read_deferral'; }
export function pendingReadRetryAt(collection: ReadCollectionState): number | null {
  const times = collection.pending?.items.flatMap(item => item.status !== 'success' && item.retryAt !== undefined ? [item.retryAt] : []) ?? [];
  return times.length ? Math.max(...times) : null;
}
export interface ReadCollectionState {
  kind: 'batch' | 'paged';
  snapshot: string | null;
  pages: ReadPage[];
  pending: ReadPage | null;
  nextCursor: string | null;
  exhausted: boolean;
  totalItems: number | null;
  seenCursors: string[];
  batchExpected: ReadKey[] | null;
  /** Accepted responses, including retries. Durable dispatch accounting also bounds failed calls. */
  calls: number;
  acceptedRequestIds: string[];
}
