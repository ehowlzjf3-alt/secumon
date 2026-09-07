import type { SessionScope } from './session.js';

export type KnowledgeKind = 'experience' | 'fact' | 'procedure_candidate' | 'personal';
export interface PersonalMemoryOwner { schemaVersion: 1; agentId: string; principalId: string }
export interface PersonalMemoryRef extends PersonalMemoryOwner { tenantId: string; id: string; revision: number }
export type KnowledgeStoreScope = { agentId: string; partition: 'work' } |
  { agentId: string; partition: 'personal'; principalId: string };

interface KnowledgeSourceBase {
  workId: string;
  ownerId: string;
  sourceId: string;
  sourceVersion: string;
  generation: number;
  observedAt: number;
  recordedAt: number;
  coverage: 'complete' | 'partial' | 'unknown';
  labels: string[];
}
/** The absent discriminator is the original Evidence encoding; do not rewrite old hashes. */
export interface EvidenceKnowledgeSource extends KnowledgeSourceBase { type?: 'evidence' | undefined; evidenceId: string }
export interface SessionUserKnowledgeSource extends KnowledgeSourceBase {
  type: 'session_user_receipt'; schemaVersion: 1; session: SessionScope;
  messageId: string; sequence: number; receiptDigest: string; quote: string;
}
export type KnowledgeSource = EvidenceKnowledgeSource | SessionUserKnowledgeSource;
export interface KnowledgeParent { id: string; revision: number }
export interface KnowledgeRecord {
  schemaVersion?: 2 | undefined;
  owner?: PersonalMemoryOwner | undefined;
  id: string;
  tenantId: string;
  namespace: string;
  scope: string;
  authorId: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  labels: string[];
  revision: number;
  contentRevision: number;
  status: 'active' | 'retracted' | 'deleted';
  visibility: 'private' | 'shared';
  reviewState: 'private' | 'submitted' | 'reviewed';
  review: { reviewerId: string; contentRevision: number; at: number; reason: string } | null;
  sources: KnowledgeSource[];
  derivedFrom: KnowledgeParent[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}

/** A transport must resolve this context from its authenticated session, never tool arguments. */
export interface TrustedKnowledgeActor {
  agentId?: string | undefined;
  tenantId: string;
  principalId: string;
  allowedLabels: string[];
  allowedDestinations?: string[];
  allowedNamespaces: string[];
  allowedScopes: string[];
  canReview: boolean;
  canPublish: boolean;
}

export interface KnowledgeCard {
  owner?: PersonalMemoryOwner | undefined;
  id: string;
  namespace: string;
  scope: string;
  authorId: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  revision: number;
  contentRevision: number;
  visibility: 'private' | 'shared';
  reviewState: KnowledgeRecord['reviewState'];
  review: KnowledgeRecord['review'];
  observedFrom: number;
  observedThrough: number;
  recordedAt: number;
  expiresAt: number | null;
  sourceVersions: string[];
  coverage: KnowledgeSource['coverage'];
}

interface KnowledgeSourceStampBase {
  workId: string;
  sourceVersion: string;
  generation: number;
  workRevision: number;
  policyDigest: string;
}
export interface EvidenceKnowledgeSourceStamp extends KnowledgeSourceStampBase { type?: 'evidence' | undefined; evidenceId: string }
export interface SessionUserKnowledgeSourceStamp extends KnowledgeSourceStampBase {
  type: 'session_user_receipt'; schemaVersion: 1; session: SessionScope;
  messageId: string; sequence: number; receiptDigest: string;
}
export type KnowledgeSourceStamp = EvidenceKnowledgeSourceStamp | SessionUserKnowledgeSourceStamp;
/** Internal custody metadata: exclude this envelope from model/public card output. */
export interface KnowledgeDependency {
  schemaVersion?: 2 | undefined;
  owner?: PersonalMemoryOwner | undefined;
  tenantId: string;
  knowledgeId: string;
  knowledgeRevision: number;
  actorDigest: string;
  sources: KnowledgeSourceStamp[];
  parents: KnowledgeParent[];
}
export interface KnowledgeRead { card: KnowledgeCard; dependency: KnowledgeDependency }
export interface KnowledgeIndexHead { revision: number; cursor: number; error: string | null }
export interface KnowledgeQuery {
  namespace: string;
  scope: string;
  text: string;
  kinds: KnowledgeKind[];
  observedFrom: number | null;
  observedThrough: number | null;
  limit: number;
}
export interface KnowledgeSearch {
  cards: KnowledgeCard[];
  dependencies: KnowledgeDependency[];
  index: KnowledgeIndexHead & { status: 'ready' | 'lagging' | 'error'; complete: boolean; cached: boolean };
}

export function canReadKnowledge(record: KnowledgeRecord, actor: TrustedKnowledgeActor, now: number): boolean {
  if (record.kind === 'personal') return record.schemaVersion === 2 && record.owner?.schemaVersion === 1 &&
    record.owner.agentId === actor.agentId && record.owner.principalId === actor.principalId && record.authorId === actor.principalId &&
    record.tenantId === actor.tenantId && actor.allowedNamespaces.includes(record.namespace) && record.scope === 'personal' &&
    record.status === 'active' && (record.expiresAt === null || record.expiresAt > now) &&
    record.labels.every(label => actor.allowedLabels.includes(label)) && record.visibility === 'private' && record.reviewState === 'private' && record.review === null;
  if (record.owner !== undefined || record.schemaVersion !== undefined) return false;
  return record.tenantId === actor.tenantId && actor.allowedNamespaces.includes(record.namespace) &&
    actor.allowedScopes.includes(record.scope) && record.status === 'active' &&
    (record.expiresAt === null || record.expiresAt > now) && record.labels.every(l => actor.allowedLabels.includes(l)) &&
    (record.authorId === actor.principalId || (record.visibility === 'shared' && record.reviewState === 'reviewed' &&
      record.review !== null && record.review.reviewerId !== record.authorId && record.review.contentRevision === record.contentRevision) ||
      (record.reviewState === 'submitted' && actor.canReview));
}

export function knowledgeCard(record: KnowledgeRecord): KnowledgeCard {
  return { ...(record.owner ? { owner: structuredClone(record.owner) } : {}), id: record.id, namespace: record.namespace, scope: record.scope, authorId: record.authorId, kind: record.kind,
    title: record.title, body: record.body, revision: record.revision, contentRevision: record.contentRevision,
    visibility: record.visibility, reviewState: record.reviewState, review: record.review,
    observedFrom: Math.min(...record.sources.map(s => s.observedAt)), observedThrough: Math.max(...record.sources.map(s => s.observedAt)),
    recordedAt: Math.max(...record.sources.map(s => s.recordedAt)), expiresAt: record.expiresAt,
    sourceVersions: [...new Set(record.sources.map(s => s.sourceVersion))],
    coverage: record.sources.every(s => s.coverage === 'complete') ? 'complete' : record.sources.some(s => s.coverage === 'partial') ? 'partial' : 'unknown' };
}

export function knowledgeSourceKey(source: KnowledgeSource | KnowledgeSourceStamp): string {
  return source.type === 'session_user_receipt' ? JSON.stringify(['session_user_receipt', source.session, source.messageId, source.sequence]) :
    `${source.workId}\u0000${source.evidenceId}`;
}
