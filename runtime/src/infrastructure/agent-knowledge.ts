import type { KnowledgeCommit, KnowledgeRepository, KnowledgeStoreScope } from '../application/knowledge-ports.js';
import type { KnowledgeQuery, TrustedKnowledgeActor } from '../domain/knowledge.js';

/** One host-selected canonical repository per partition; failures never change the routing. */
export class AgentKnowledgeRepository implements KnowledgeRepository {
  #closed = false;
  constructor(readonly work: KnowledgeRepository, readonly personal: KnowledgeRepository, readonly agentId: string) {}
  #target(scope?: KnowledgeStoreScope) {
    if (this.#closed) throw new Error('knowledge_repository_closed');
    if (scope !== undefined && (scope.agentId !== this.agentId || !['work', 'personal'].includes(scope.partition))) {
      throw new Error('knowledge_scope_mismatch');
    }
    return scope?.partition === 'personal' ? this.personal : this.work;
  }
  async get(tenantId: string, id: string, scope?: KnowledgeStoreScope) { return this.#target(scope).get(tenantId, id, scope); }
  async receipt(tenantId: string, id: string, commandId: string, scope?: KnowledgeStoreScope) { return this.#target(scope).receipt(tenantId, id, commandId, scope); }
  async commit(command: KnowledgeCommit) { return this.#target(command.scope).commit(command); }
  async indexHead(tenantId: string, namespace: string, scope?: KnowledgeStoreScope) { return this.#target(scope).indexHead(tenantId, namespace, scope); }
  async candidates(actor: TrustedKnowledgeActor, query: KnowledgeQuery, maximum: number, scope?: KnowledgeStoreScope) {
    return this.#target(scope).candidates(actor, query, maximum, scope);
  }
  async rebuildIndex(tenantId: string, namespace: string, scope?: KnowledgeStoreScope) { return this.#target(scope).rebuildIndex(tenantId, namespace, scope); }
  async markIndexError(tenantId: string, namespace: string, code: string, scope?: KnowledgeStoreScope) { return this.#target(scope).markIndexError(tenantId, namespace, code, scope); }
  async close() {
    if (this.#closed) return; this.#closed = true;
    const errors: unknown[] = [];
    for (const repository of new Set([this.personal, this.work])) { try { await repository.close(); } catch (error) { errors.push(error); } }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'knowledge_repository_close_failed');
  }
}
