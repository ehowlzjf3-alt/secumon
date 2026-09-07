import { z } from 'zod';
import type { ComputerOperationIdentity, ComputerOperationLookupResult, ComputerOperationReceipt } from '../domain/computer-operation.js';
import type { ComputerLease } from '../domain/computer-use.js';
import type { ComputerDriver } from './computer-use-ports.js';
import { ComputerActionSchema, ComputerDriverIdentitySchema } from './computer-use-contracts.js';
import { parseContract, ToolUsageSchema } from './contracts.js';

const id = z.string().min(1).max(256);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const ComputerOperationIdentitySchema: z.ZodType<ComputerOperationIdentity> = z.strictObject({
  workId: id, attemptId: id, sessionId: id, epoch: count.min(1), surfaceId: id, operationId: id,
  viewRevision: count, focusRevision: count, targetRef: id, action: ComputerActionSchema,
});
export const ComputerOperationReceiptSchema: z.ZodType<ComputerOperationReceipt> = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('computer_operation_receipt'), driver: ComputerDriverIdentitySchema,
  identity: ComputerOperationIdentitySchema, outcome: z.enum(['applied', 'not_applied']), decidedAt: count, effectSequence: count,
});
export const ComputerOperationLookupResultSchema: z.ZodType<ComputerOperationLookupResult> = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('found'), receipt: ComputerOperationReceiptSchema, reason: z.null(), usage: ToolUsageSchema }),
  z.strictObject({ status: z.literal('unknown'), receipt: z.null(), reason: id, usage: ToolUsageSchema }),
]);

/** Captures requested identity only; live lease, basis and input authorization still belong to the driver. */
export function computerOperationIdentity(lease: ComputerLease, request: Parameters<ComputerDriver['act']>[1]): ComputerOperationIdentity {
  return parseContract(ComputerOperationIdentitySchema, { workId: lease.workId, attemptId: lease.attemptId, sessionId: lease.sessionId,
    epoch: lease.epoch, surfaceId: lease.surfaceId, operationId: request.operationId, viewRevision: request.basis.revision,
    focusRevision: request.basis.focusRevision, targetRef: request.targetRef, action: request.action });
}
