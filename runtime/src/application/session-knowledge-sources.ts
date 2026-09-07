import type { SessionUserKnowledgeSource, SessionUserKnowledgeSourceStamp, TrustedKnowledgeActor } from '../domain/knowledge.js';
import type { SessionScope } from '../domain/session.js';
import type { WorkState } from '../domain/model.js';
import { dataGeneration } from '../domain/data-lifecycle.js';
import type { KnowledgeUserSources } from './knowledge-ports.js';
import type { SessionRepository } from './session-ports.js';
import type { RuntimeServices } from './services.js';
import { sessionOriginalEligible, validateSessionUserOriginal } from './session-original-validation.js';
import { asJson } from './plan-validator.js';

type Services = Pick<RuntimeServices, 'state' | 'artifacts' | 'digester' | 'planner'>;
const unavailable = () => new Error('knowledge_unavailable');

function originalGeneration(work: WorkState): number {
  const changes = work.dataLifecycle?.changes ?? [];
  if (new Set(changes.map(change => change.id)).size !== changes.length) throw unavailable();
  // Only a recorded quarantine of derived copies leaves the user original's epoch unchanged.
  const derivedQuarantines = changes.filter(change => change.action === 'dependency_changed' &&
    change.id.startsWith('knowledge-invalid:') && change.reason === 'knowledge_dependency_changed' && change.purge === 'not_requested').length;
  const generation = dataGeneration(work) - derivedQuarantines;
  if (!Number.isSafeInteger(generation) || generation < 0) throw unavailable();
  return generation;
}

/** User originals do not inherit the model/tool dependencies of the work that received them. */
export class SessionKnowledgeSources implements KnowledgeUserSources {
  constructor(readonly services: Services, readonly repository: SessionRepository, readonly agentId: string) {}
  #digest(value: unknown) { return this.services.digester.digest(asJson(value)); }
  async #inspect(actor: TrustedKnowledgeActor, ref: { sessionId: string; messageId: string; quote: string }) {
    if (actor.agentId !== this.agentId || !ref.quote.length || ref.quote.length > 16384 ||
      (actor.allowedDestinations && !actor.allowedDestinations.includes(this.services.planner.destination))) throw unavailable();
    const scope: SessionScope = { tenantId: actor.tenantId, agentId: this.agentId, principalId: actor.principalId, sessionId: ref.sessionId };
    const receipt = await this.repository.input(scope, ref.messageId);
    if (!receipt || receipt.status !== 'applied' || this.#digest(receipt.scope) !== this.#digest(scope) || !receipt.text.includes(ref.quote)) throw unavailable();
    const work = await this.services.state.get(receipt.workId), basis = work?.conversation?.session;
    if (!work || !basis || work.policy.tenantId !== actor.tenantId || work.policy.principalId !== actor.principalId ||
      this.#digest(basis.scope) !== this.#digest(scope) || basis.input.sequence < receipt.sequence ||
      !actor.allowedScopes.includes(work.goal.scope) || !receipt.labels.every(label => actor.allowedLabels.includes(label))) throw unavailable();
    let found = false;
    let cursor: string | undefined;
    do {
      const page = await this.repository.history(scope, work.policy, { limit: 64, afterSequence: receipt.sequence - 1,
        throughSequence: receipt.sequence, ...(cursor ? { cursor } : {}) });
      for (const entry of page.entries) {
        if (found || entry.role !== 'user' || entry.sourceId !== ref.messageId) throw unavailable();
        validateSessionUserOriginal(entry, receipt, scope, value => this.#digest(value));
        if (!sessionOriginalEligible(work, basis, entry, work, this.services.planner.destination, value => this.#digest(value))) throw unavailable();
        found = true;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    if (!found) throw unavailable();
    const stableWork = await this.services.state.get(work.id), stableReceipt = await this.repository.input(scope, ref.messageId);
    if (!stableWork || this.#digest({ policy: stableWork.policy, generation: originalGeneration(stableWork), scope: stableWork.goal.scope,
      session: stableWork.conversation?.session }) !== this.#digest({ policy: work.policy, generation: originalGeneration(work), scope: work.goal.scope,
      session: basis }) || this.#digest(stableReceipt) !== this.#digest(receipt)) throw new Error('knowledge_contention');
    const sourceVersion = this.#digest({ type: 'session_user_receipt', scope, messageId: receipt.messageId,
      sequence: receipt.sequence, digest: receipt.digest, quote: ref.quote });
    const source: SessionUserKnowledgeSource = { type: 'session_user_receipt', schemaVersion: 1, session: scope,
      messageId: receipt.messageId, sequence: receipt.sequence, receiptDigest: receipt.digest, quote: ref.quote,
      workId: work.id, ownerId: actor.principalId, sourceId: receipt.messageId, sourceVersion, generation: originalGeneration(work),
      observedAt: receipt.receivedAt, recordedAt: receipt.receivedAt, coverage: 'unknown', labels: [...receipt.labels] };
    const stamp: SessionUserKnowledgeSourceStamp = { type: 'session_user_receipt', schemaVersion: 1, session: scope,
      messageId: receipt.messageId, sequence: receipt.sequence, receiptDigest: receipt.digest,
      workId: work.id, sourceVersion, generation: source.generation, workRevision: work.revision,
      policyDigest: this.#digest({ policy: work.policy, scope: work.goal.scope, destination: this.services.planner.destination }) };
    return { source, stamp };
  }
  async capture(actor: TrustedKnowledgeActor, ref: { sessionId: string; messageId: string; quote: string }): Promise<SessionUserKnowledgeSource> {
    return (await this.#inspect(actor, ref)).source;
  }
  async current(source: SessionUserKnowledgeSource, actor: TrustedKnowledgeActor): Promise<SessionUserKnowledgeSourceStamp> {
    const checked = await this.#inspect(actor, { sessionId: source.session.sessionId, messageId: source.messageId, quote: source.quote });
    if (this.#digest(checked.source) !== this.#digest(source)) throw unavailable();
    return checked.stamp;
  }
}
