import type { WorkState } from '../domain/model.js';
import type { AppliedSessionInput, SessionEntry, SessionInbox, SessionScope } from '../domain/session.js';
import { allowsDisclosure } from '../domain/disclosure.js';

type Digest = (value: unknown) => string;

/** Compare the supplied snapshots without fetching or trusting a prior validation result. */
export function validateSessionUserOriginal(entry: SessionEntry, receipt: SessionInbox | null, scope: SessionScope, digest: Digest): void {
  if (entry.role === 'user' && (!receipt || digest(receipt.scope) !== digest(scope) ||
    receipt.digest !== digest({ scope: receipt.scope, text: receipt.text, payload: receipt.payload, kind: receipt.kind, workId: receipt.workId }) ||
    entry.sequence !== receipt.sequence || entry.sourceId !== receipt.messageId || entry.workId !== receipt.workId || entry.text !== receipt.text ||
    entry.kind !== receipt.kind || entry.artifact !== null || digest(entry.labels) !== digest(receipt.labels))) throw new Error('session_original_invalid');
}

export function sessionOriginalEligible(state: WorkState, basis: AppliedSessionInput, entry: SessionEntry, source: WorkState,
  destination: string, digest: Digest): boolean {
  if (source.policy.tenantId !== state.policy.tenantId || source.policy.principalId !== state.policy.principalId ||
    digest(source.conversation?.session?.scope ?? null) !== digest(basis.scope)) throw new Error('session_source_unavailable');
  const labels = [...entry.labels, ...(entry.artifact?.labels ?? [])];
  return labels.every(label => state.policy.allowedLabels.includes(label) && source.policy.allowedLabels.includes(label)) &&
    [state.policy, source.policy].every(policy => policy.allowedDestinations.includes(destination) && allowsDisclosure(policy, destination, 'model', labels));
}
