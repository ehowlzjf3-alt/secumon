import type { Policy, WorkState } from '../domain/model.js';
import type { AppliedSessionInput, SessionEntry } from '../domain/session.js';
import type { SessionQuote, SessionSourceManifest } from '../domain/session-compact.js';
import { artifactBlocked, dataGeneration } from '../domain/data-lifecycle.js';
import type { SessionRepository } from './session-ports.js';
import type { RuntimeServices } from './services.js';
import { asJson } from './plan-validator.js';
import { sessionOriginalEligible, validateSessionUserOriginal } from './session-original-validation.js';

type Services = Pick<RuntimeServices, 'state' | 'artifacts' | 'digester' | 'planner'>;
export interface SessionOriginal { entry: SessionEntry; eligible: boolean; pending: boolean; provenance: string }
export class SessionOriginals {
  constructor(readonly services: Services, readonly repository: SessionRepository) {}
  digest(value: unknown) { return this.services.digester.digest(asJson(value)); }
  policyDigest(policy: Policy) { return this.digest({ policy, destination: this.services.planner.destination }); }
  seed(basis: AppliedSessionInput, policy: Policy) { return this.digest({ scope: basis.scope, policy: this.policyDigest(policy) }); }
  async *read(state: WorkState, basis: AppliedSessionInput, afterSequence: number, throughSequence: number, signal?: AbortSignal): AsyncGenerator<SessionOriginal> {
    if (afterSequence >= throughSequence) return;
    let cursor: string | undefined;
    do {
      if (signal?.aborted) throw new Error('session_compact_interrupted');
      const page = await this.repository.history(basis.scope, state.policy, { limit: 64, afterSequence, throughSequence, ...(cursor ? { cursor } : {}) });
      for (const entry of page.entries) {
        const receipt = entry.role === 'user' ? await this.repository.input(basis.scope, entry.sourceId) : null;
        validateSessionUserOriginal(entry, receipt, basis.scope, value => this.digest(value));
        if (entry.role === 'user' && receipt?.status !== 'applied') {
          if (!receipt) throw new Error('session_source_unavailable');
          yield { entry, eligible: false, pending: receipt.status === 'pending', provenance: this.digest({ entry, receipt: receipt.status }) };
          continue;
        }
        const source = await this.services.state.get(entry.workId);
        if (!source) throw new Error('session_source_unavailable');
        const eligible = sessionOriginalEligible(state, basis, entry, source, this.services.planner.destination, value => this.digest(value));
        if (eligible && entry.artifact && (artifactBlocked(source, entry.artifact) || !(await this.services.artifacts.exists(entry.artifact)))) throw new Error('session_source_unavailable');
        yield { entry, eligible, pending: false, provenance: this.digest({ entry, sourcePolicy: source.policy, generation: dataGeneration(source), eligible }) };
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
  async manifest(state: WorkState, basis: AppliedSessionInput, throughSequence: number, quotes: SessionQuote[] = [], signal?: AbortSignal): Promise<SessionSourceManifest> {
    let digest = this.seed(basis, state.policy); let entries = 0;
    const found = new Set<number>();
    for await (const row of this.read(state, basis, 0, throughSequence, signal)) {
      if (row.pending) throw new Error('session_compact_input_pending');
      digest = this.digest({ previous: digest, source: row.provenance });
      if (row.eligible) {
        entries++;
        quotes.forEach((quote, index) => {
          if (quote.sequence === row.entry.sequence && quote.sourceId === row.entry.sourceId && quote.role === row.entry.role && row.entry.text.includes(quote.quote)) found.add(index);
        });
      }
    }
    if (found.size !== quotes.length) throw new Error('session_compact_quote_unavailable');
    return { throughSequence, digest, entries };
  }
}
