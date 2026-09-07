import { z } from 'zod';
import type { CommitRequest } from './ports.js';
import type { Delivery, StoredEvent, WorkState } from '../domain/model.js';
import { disclosureTransitionError } from '../domain/disclosure.js';
import { reconciliationTransitionError } from '../domain/computer-reconciliation.js';
import { continuationTransitionError } from '../domain/computer-continuation.js';
import { ArtifactSchema, ConversationBindingSchema, JsonSchema, WorkStateSchema, parseContract } from './contracts.js';

const id = z.string().min(1).max(256);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const DeliverySchema: z.ZodType<Delivery> = z.strictObject({ id, workId: id, goalRevision: count.min(1), destination: id,
  kind: z.enum(['ack', 'question', 'result', 'failure']), text: z.string().max(100_000), status: z.enum(['pending', 'sending', 'delivered', 'unknown', 'superseded', 'failed']), externalId: id.nullable(),
  context: z.strictObject({ binding: ConversationBindingSchema, labels: z.array(id), sourceRevision: count.min(1), dataGeneration: count.optional(), responseId: id.nullable(), evidenceIds: z.array(id), evidenceDigest: id.nullable(), obligationIds: z.array(id), artifact: ArtifactSchema.nullable(),
    generatedAnswerDigest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).nullable().default(null),
  dispatch: z.strictObject({ owner: id, leaseUntil: count, attempts: count, lastError: id.nullable() }).nullable().default(null) });
const event = z.strictObject({ type: id, at: count, data: z.record(z.string(), JsonSchema) });
export const StoredEventSchema: z.ZodType<StoredEvent> = event.extend({ workId: id, revision: count.min(1), sequence: count.min(1), commandId: id });
const CommitSchema: z.ZodType<CommitRequest> = z.strictObject({ workId: id, expectedRevision: count, commandId: id, commandDigest: id,
  next: WorkStateSchema, events: z.array(event).min(1), deliveries: z.array(DeliverySchema) });
export function validateCommit(request: CommitRequest): CommitRequest {
  const input = parseContract(CommitSchema, request);
  const next = input.next;
  if (input.workId !== next.id || next.revision !== input.expectedRevision + 1 || next.updatedAt < next.createdAt ||
      input.deliveries.some(d => d.workId !== next.id) || new Set(input.deliveries.map(d => d.id)).size !== input.deliveries.length) throw new Error('invalid_commit');
  return input;
}
export function validateStateTransition(prior: WorkState | null, next: WorkState): void {
  const error = disclosureTransitionError(prior, next); if (error) throw new Error(error);
  const reconciliationError = reconciliationTransitionError(prior, next); if (reconciliationError) throw new Error(reconciliationError);
  const continuationError = continuationTransitionError(prior, next); if (continuationError) throw new Error(continuationError);
}
