import { z } from 'zod';
import type { Attempt, WorkState } from '../domain/model.js';
import type { RuntimeServices } from './services.js';
import { ToolExecutionSchema } from './contracts.js';
import { asJson } from './plan-validator.js';

type Services = Pick<RuntimeServices, 'state' | 'digester'>;
const payloadSchema = z.strictObject({ payload: z.strictObject({
  attemptId: z.string().min(1).max(256), source: z.string().regex(/^[a-f0-9]{64}$/),
}) });
function identity(attempt: Attempt) {
  return { id: attempt.id, taskId: attempt.taskId, planRevision: attempt.planRevision, goalRevision: attempt.goalRevision,
    toolId: attempt.toolId, toolVersion: attempt.toolVersion, inputDigest: attempt.inputDigest, scope: attempt.scope,
    contractDigest: attempt.contractDigest ?? null, owner: attempt.owner, startedAt: attempt.startedAt, leaseUntil: attempt.leaseUntil,
    effect: attempt.effect, effectState: attempt.effectState, readProgress: attempt.readProgress ?? null,
    reuse: attempt.reuse ?? null, computerUse: attempt.computerUse ?? null, effectReceipt: attempt.effectReceipt ?? null };
}
function sameOwner(left: WorkState, right: WorkState) {
  return left.id === right.id && left.createdAt === right.createdAt && left.policy.tenantId === right.policy.tenantId &&
    left.policy.principalId === right.policy.principalId;
}

/** Recognizes prior accounting only. It does not validate a body, re-open raw custody or grant execution permission. */
export async function recordedStoredUsageAttempts(services: Services, state: WorkState, candidateIds: readonly string[]): Promise<Set<string>> {
  const captured = structuredClone(state), wanted = new Set(candidateIds), found = new Set<string>();
  const digest = (value: unknown) => services.digester.digest(asJson(value));
  const same = (left: unknown, right: unknown) => digest(left) === digest(right);
  const current = async () => {
    const actual = await services.state.get(captured.id);
    if (actual && !sameOwner(actual, captured)) throw new Error('stored_usage_owner_mismatch');
    if (!actual || !same(actual, captured)) throw new Error('stored_usage_changed');
  };
  await current();
  const candidates = new Map<string, Attempt>();
  for (const id of wanted) {
    const matches = captured.attempts.filter(attempt => attempt.id === id), attempt = matches[0];
    if (matches.length > 1) throw new Error('stored_usage_owner_mismatch');
    if (attempt?.execution?.mode === 'invoked' && ToolExecutionSchema.safeParse(attempt.execution).success) candidates.set(id, attempt);
  }
  if (!candidates.size) return found;
  const events = await services.state.events(captured.id, 0);
  const receipts = new Map<string, Awaited<ReturnType<Services['state']['receipt']>>>();
  for (const event of events) {
    if (event.workId !== captured.id) throw new Error('stored_usage_owner_mismatch');
    if (event.type !== 'tool_execution_usage_recorded') continue;
    const parsed = payloadSchema.safeParse(event.data);
    if (!parsed.success) continue;
    const payload = parsed.data.payload, attempt = candidates.get(payload.attemptId);
    if (!attempt || found.has(attempt.id) || attempt.execution?.mode !== 'invoked' ||
        event.commandId !== `tool-usage:${attempt.id}:${payload.source}` || !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
        !Number.isSafeInteger(event.revision) || event.revision < 1 || event.revision > captured.revision ||
        !Number.isSafeInteger(event.at) || event.at < attempt.startedAt || event.at > captured.updatedAt) continue;
    if (!receipts.has(event.commandId)) receipts.set(event.commandId, await services.state.receipt(captured.id, event.commandId));
    const receipt = receipts.get(event.commandId);
    if (!receipt) continue;
    if (!sameOwner(receipt.state, captured)) throw new Error('stored_usage_owner_mismatch');
    const matches = receipt.state.attempts.filter(value => value.id === attempt.id), recorded = matches[0];
    if (matches.length > 1) throw new Error('stored_usage_owner_mismatch');
    if (receipt.digest !== digest({ type: 'tool_execution_usage_recorded', data: payload }) ||
        receipt.state.revision !== event.revision || receipt.state.updatedAt !== event.at ||
        !recorded || !recorded.execution || recorded.execution.mode !== 'invoked' ||
        !ToolExecutionSchema.safeParse(recorded.execution).success || !same(identity(recorded), identity(attempt)) ||
        !same(recorded.execution, attempt.execution)) continue;
    found.add(attempt.id);
  }
  // Retention/deletion may change lifecycle since accounting; only the captured current state must remain unchanged during this lookup.
  await current();
  return found;
}
