import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { KnowledgeCommit, KnowledgeStoreScope } from '../application/knowledge-ports.js';
import type { KnowledgeQuery, KnowledgeRecord, TrustedKnowledgeActor } from '../domain/knowledge.js';
import { bindAgentDatabase } from '../infrastructure/agent-database-owner.js';
import { Sha256Digester } from '../infrastructure/digest.js';

export function storageFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'personal-knowledge-'))); const path = join(directory, 'memory.sqlite');
  const agentId = randomUUID(); const otherAgentId = randomUUID();
  return { directory, path, agentId, otherAgentId, bind: () => bindAgentDatabase(path, agentId, 'memory'), close: () => rmSync(directory, { recursive: true, force: true }) };
}
export const ownerScope = (agentId: string, principalId = 'user-a'): KnowledgeStoreScope & { partition: 'personal'; principalId: string } => ({ agentId, partition: 'personal', principalId });
export function personalRecord(agentId: string, principalId = 'user-a', tenantId = 'tenant-a', body = '답변은 한국어로 작성해 주세요.'): KnowledgeRecord {
  return { schemaVersion: 2, owner: { schemaVersion: 1, agentId, principalId }, id: 'same-memory', tenantId, namespace: 'personal', scope: 'personal', authorId: principalId,
    kind: 'personal', title: '답변 형식', body, labels: [], revision: 1, contentRevision: 1, status: 'active', visibility: 'private', reviewState: 'private', review: null,
    sources: [{ type: 'session_user_receipt', schemaVersion: 1, session: { tenantId, agentId, principalId, sessionId: 'session-a' },
      messageId: 'message-a', sequence: 1, receiptDigest: 'a'.repeat(64), quote: body, workId: 'work-a', ownerId: principalId,
      sourceId: 'session-a/message-a', sourceVersion: 'b'.repeat(64), generation: 0, observedAt: 100, recordedAt: 101, coverage: 'unknown', labels: [] }],
    derivedFrom: [], createdAt: 110, updatedAt: 110, expiresAt: null };
}
export function legacyRecord(): KnowledgeRecord {
  return { id: 'legacy-memory', tenantId: 'tenant-a', namespace: 'team', scope: 'fixture', authorId: 'user-a', kind: 'experience', title: 'Evidence 기억',
    body: '보존 기간 관측', labels: [], revision: 1, contentRevision: 1, status: 'active', visibility: 'private', reviewState: 'private', review: null,
    sources: [{ workId: 'work-a', evidenceId: 'evidence-a', ownerId: 'user-a', sourceId: 'document-a', sourceVersion: 'b'.repeat(64), generation: 0,
      observedAt: 100, recordedAt: 101, coverage: 'complete', labels: [] }], derivedFrom: [], createdAt: 110, updatedAt: 110, expiresAt: null };
}
export function storageCommand(next: KnowledgeRecord, commandId = 'same-command', scope?: KnowledgeStoreScope): KnowledgeCommit {
  return { next, commandId, expectedRevision: next.revision - 1, commandDigest: new Sha256Digester().digest({ commandId, body: next.body, revision: next.revision }),
    ...(scope === undefined ? {} : { scope }) };
}
export function personalActor(agentId: string, principalId = 'user-a', tenantId = 'tenant-a'): TrustedKnowledgeActor {
  return { agentId, principalId, tenantId, allowedLabels: [], allowedNamespaces: ['personal'], allowedScopes: ['fixture'], canReview: true, canPublish: true };
}
export const personalQuery: KnowledgeQuery = { namespace: 'personal', scope: 'personal', text: '', kinds: ['personal'], observedFrom: null, observedThrough: null, limit: 5 };
export function correctedRecord(prior: KnowledgeRecord, body = '답변은 한국어로 쓰고 마지막에 근거를 붙여 주세요.'): KnowledgeRecord {
  const next = structuredClone(prior); next.body = body; next.revision++; next.contentRevision++; next.updatedAt++;
  const source = next.sources[0]; if (!source || source.type !== 'session_user_receipt') throw new Error('invalid_personal_fixture');
  source.messageId = 'message-' + next.revision; source.sequence = next.revision; source.quote = body; source.receiptDigest = String(next.revision).repeat(64);
  return next;
}
