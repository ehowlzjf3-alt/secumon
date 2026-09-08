import type { Delivery, Json, WorkState } from '../domain/model.js';
import type { RuntimeServices } from './services.js';
import { commitWithArtifacts } from './commit-artifacts.js';

/** A replay returns current state while commandRevision identifies the original recorded command. */
export async function transact(services: Pick<RuntimeServices, 'state' | 'artifacts' | 'clock' | 'digester'>, workId: string, commandId: string,
  type: string, data: Json, edit: (state: WorkState) => Delivery[] | void, beforeCommit?: () => Promise<void>): Promise<{ state: WorkState; committed: boolean; commandRevision: number }> {
  const digest = services.digester.digest({ type, data });
  for (let retry = 0; retry < 8; retry++) {
    const receipt = await services.state.receipt(workId, commandId);
    if (receipt) {
      if (receipt.digest !== digest) throw new Error('idempotency_conflict');
      const state = await services.state.get(workId); if (!state) throw new Error('work_not_found');
      return { state, committed: false, commandRevision: receipt.state.revision };
    }
    const prior = await services.state.get(workId); if (!prior) throw new Error('work_not_found');
    const next = structuredClone(prior); const deliveries = edit(next) ?? [];
    next.revision++; next.updatedAt = services.clock.now();
    const result = await commitWithArtifacts(services.state, services.artifacts, { workId, expectedRevision: prior.revision, commandId, commandDigest: digest, next,
      events: [{ type, at: next.updatedAt, data: { payload: data } }], deliveries }, beforeCommit);
    if (result.kind === 'committed') return { state: result.state, committed: true, commandRevision: result.state.revision };
    if (result.kind === 'duplicate') { const state = await services.state.get(workId); if (!state) throw new Error('work_not_found'); return { state, committed: false, commandRevision: result.state.revision }; }
    if (result.kind === 'idempotency_conflict') throw new Error('idempotency_conflict');
  }
  throw new Error('state_contention');
}
