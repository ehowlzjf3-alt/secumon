import { z } from 'zod';

const text = (maximum: number) => z.string().min(1).max(maximum).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const AGENT_RESTORE_RECONCILIATION = '.secumon-restore-reconciliation.json';
export const AGENT_RESTORE_RECONCILIATION_PENDING = '.secumon-restore-reconciliation-pending.json';
export const AgentRestoreReconciliationBasisSchema = z.strictObject({
  schemaVersion: z.literal(1), agentId: z.uuid(), root: text(4096), restorationId: z.uuid(),
  restoreKind: z.enum(['local', 'postgres']), operationId: text(256), backupDigest: digest,
  completionDigest: digest, identityHeadDigest: digest, localTreeDigest: digest, digest,
});
export const AgentRestoreReconciliationReportSchema = z.strictObject({
  sourceId: text(256), sourceRevision: text(256), basisDigest: digest,
  status: z.enum(['consistent', 'unresolved']), sourceHead: text(2048),
  evidence: z.array(z.strictObject({ reference: text(4096), digest })).min(1).max(128),
  unresolved: z.array(text(4096)).max(128),
}).refine(value => value.status === 'consistent' ? value.unresolved.length === 0 : value.unresolved.length > 0,
  'report status must preserve unresolved external history');
export const AgentRestoreReconciliationReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('agent-restore-reconciliation'),
  basis: AgentRestoreReconciliationBasisSchema,
  reports: z.array(AgentRestoreReconciliationReportSchema).min(1).max(64),
  checkedAt: z.number().int().nonnegative(), digest,
});
export const AgentRestoreReconciliationPendingSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('agent-restore-reconciliation-pending'),
  basis: AgentRestoreReconciliationBasisSchema,
});
export type AgentRestoreReconciliationBasis = z.infer<typeof AgentRestoreReconciliationBasisSchema>;
export type AgentRestoreReconciliationReport = z.infer<typeof AgentRestoreReconciliationReportSchema>;
export type AgentRestoreReconciliationReceipt = z.infer<typeof AgentRestoreReconciliationReceiptSchema>;

/** Trusted host readers collectively cover the agent's entire external history: tools, deliveries,
 * delegated work and resource accounting, including records erased by an older backup. An empty
 * restored attempt list is not proof of no effects. These methods only inspect; they must never
 * replay input, send messages, or mutate local/remote state. Evidence references locate originals;
 * verify checks both their validity and the current source head immediately before publication. */
export interface AgentRestoreReconciliationSource {
  readonly revision: string;
  inspect(basis: Readonly<AgentRestoreReconciliationBasis>, signal: AbortSignal): Promise<AgentRestoreReconciliationReport>;
  verify(basis: Readonly<AgentRestoreReconciliationBasis>, report: Readonly<AgentRestoreReconciliationReport>, signal: AbortSignal): Promise<boolean>;
}
export interface AgentRestoreReconciliationRegistration {
  readonly sources: ReadonlyMap<string, AgentRestoreReconciliationSource>;
  readonly timeoutMs?: number;
}
