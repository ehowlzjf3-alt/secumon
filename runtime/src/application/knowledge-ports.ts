import type { KnowledgeIndexHead, KnowledgeQuery, KnowledgeRecord, KnowledgeStoreScope, SessionUserKnowledgeSource, SessionUserKnowledgeSourceStamp, TrustedKnowledgeActor } from '../domain/knowledge.js';
export type { KnowledgeStoreScope } from '../domain/knowledge.js';

export interface TrustedKnowledgeActorProvider { current(): Promise<TrustedKnowledgeActor> }
/** Host directory; identities and grants must never come from model/tool arguments. */
export interface InputAuthority {
  resolve(identity: { tenantId: string; principalId: string }): Promise<TrustedKnowledgeActor | null>;
}
export interface KnowledgeCommit {
  scope?: KnowledgeStoreScope;
  expectedRevision: number;
  commandId: string;
  commandDigest: string;
  next: KnowledgeRecord;
}
export type KnowledgeCommitResult = { kind: 'committed' | 'duplicate'; revision: number } |
  { kind: 'conflict'; actualRevision: number } | { kind: 'idempotency_conflict' };
export interface KnowledgeCandidates { ids: string[]; truncated: boolean }
export interface KnowledgeRepository {
  get(tenantId: string, id: string, scope?: KnowledgeStoreScope): Promise<KnowledgeRecord | null>;
  receipt(tenantId: string, id: string, commandId: string, scope?: KnowledgeStoreScope): Promise<{ digest: string; revision: number } | null>;
  commit(command: KnowledgeCommit): Promise<KnowledgeCommitResult>;
  indexHead(tenantId: string, namespace: string, scope?: KnowledgeStoreScope): Promise<KnowledgeIndexHead>;
  candidates(actor: TrustedKnowledgeActor, query: KnowledgeQuery, maximum: number, scope?: KnowledgeStoreScope): Promise<KnowledgeCandidates>;
  rebuildIndex(tenantId: string, namespace: string, scope?: KnowledgeStoreScope): Promise<KnowledgeIndexHead>;
  markIndexError(tenantId: string, namespace: string, code: string, scope?: KnowledgeStoreScope): Promise<void>;
  close(): Promise<void>;
}

/** Reads applied user originals, never treating a user statement as verified external Evidence. */
export interface KnowledgeUserSources {
  capture(actor: TrustedKnowledgeActor, ref: { sessionId: string; messageId: string; quote: string }): Promise<SessionUserKnowledgeSource>;
  current(source: SessionUserKnowledgeSource, actor: TrustedKnowledgeActor): Promise<SessionUserKnowledgeSourceStamp>;
}

/** The scope is selected from host identity, not from a model-supplied memory identifier. */
export function scopedKnowledgeRepository(repository: KnowledgeRepository, scope: KnowledgeStoreScope): KnowledgeRepository {
  const selected = structuredClone(scope);
  return {
    get: (tenant, id) => repository.get(tenant, id, selected),
    receipt: (tenant, id, commandId) => repository.receipt(tenant, id, commandId, selected),
    commit: command => repository.commit({ ...command, scope: selected }),
    indexHead: (tenant, namespace) => repository.indexHead(tenant, namespace, selected),
    candidates: (actor, query, maximum) => repository.candidates(actor, query, maximum, selected),
    rebuildIndex: (tenant, namespace) => repository.rebuildIndex(tenant, namespace, selected),
    markIndexError: (tenant, namespace, code) => repository.markIndexError(tenant, namespace, code, selected),
    close: async () => {},
  };
}
