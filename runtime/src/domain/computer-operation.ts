import type { ComputerAction, ComputerDriverIdentity } from './computer-use.js';
import type { ToolUsage } from './model.js';

/** Identifies the original requested input, independently of the later attempt that reads its receipt. */
export interface ComputerOperationIdentity {
  workId: string;
  attemptId: string;
  sessionId: string;
  epoch: number;
  surfaceId: string;
  operationId: string;
  viewRevision: number;
  focusRevision: number;
  targetRef: string;
  action: ComputerAction;
}

export interface ComputerOperationReceipt {
  schemaVersion: 1;
  kind: 'computer_operation_receipt';
  driver: ComputerDriverIdentity;
  identity: ComputerOperationIdentity;
  outcome: 'applied' | 'not_applied';
  decidedAt: number;
  effectSequence: number;
}

export type ComputerOperationLookupResult =
  | { status: 'found'; receipt: ComputerOperationReceipt; reason: null; usage: ToolUsage }
  | { status: 'unknown'; receipt: null; reason: string; usage: ToolUsage };
