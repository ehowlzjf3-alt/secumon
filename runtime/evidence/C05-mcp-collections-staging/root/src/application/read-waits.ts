import type { Attempt, TaskSpec, WorkState } from '../domain/model.js';
import type { Control } from '../domain/control.js';
import type { Digester } from './ports.js';
import type { RuntimeServices } from './services.js';
import type { ToolContracts } from './tool-contracts.js';
import { ReadCheckpoints } from './read-checkpoints.js';
import { asJson } from './plan-validator.js';
import type { ReadCheckpoint } from '../domain/read-checkpoint.js';

function candidates(state: WorkState): Attempt[] {
  return state.attempts.filter(attempt => attempt.goalRevision === state.goal.revision && attempt.scope === state.goal.scope &&
    ['partial', 'failed', 'cancelled', 'succeeded'].includes(attempt.status) && attempt.readProgress !== undefined);
}
function queryDigest(task: TaskSpec, digester: Digester) {
  return digester.digest({ toolId: task.toolId, toolVersion: task.toolVersion, input: task.input });
}

/** Scheduling hint only. Allocation and send boundaries authenticate the original checkpoint again. */
export function readWaitControl(state: WorkState, now: number, digester: Digester, task?: TaskSpec): Control | null {
  const query = task ? queryDigest(task, digester) : null;
  const waiting = candidates(state).filter(attempt => attempt.readProgress!.phase === 'partial' &&
    attempt.readProgress!.successorAttemptId === null && attempt.readProgress!.retryAt != null && attempt.readProgress!.retryAt! > now &&
    (!task || task.readResume?.attemptId === attempt.id || attempt.readProgress!.queryDigest === query));
  if (!waiting.length) return null;
  if (waiting.some(attempt => attempt.readProgress!.remainingCalls === 0)) return { kind: 'blocked', reason: 'read_call_limit' };
  const due = Math.min(...waiting.map(attempt => attempt.readProgress!.retryAt!));
  return { kind: 'wait', reason: 'read_retry_wait', wakeAt: Math.min(due, state.deadlineAt) };
}

/** The durable response, not retryWakeAt or a model-supplied task ID, determines a read barrier. */
async function inspectReadWaits(services: RuntimeServices, contracts: ToolContracts, input: WorkState, task?: TaskSpec) {
  const state = structuredClone(input);
  // Summary fields cannot decide which original checkpoints deserve authentication.
  const selected = candidates(state).filter(attempt =>
    !task || task.readResume?.attemptId === attempt.id || attempt.toolId === task.toolId && attempt.toolVersion === task.toolVersion);
  const registration = selected.map(attempt => ({ attempt, entry: contracts.get(attempt.toolId, attempt.toolVersion) }));
  const verified: { attemptId: string; queryDigest: string; retryAt: number | null; remainingCalls: number }[] = [];
  const checkpoints = new ReadCheckpoints(services, contracts);
  const originals = new Map<string, ReadCheckpoint>();
  for (const { attempt } of registration) {
    const checkpoint = await checkpoints.read(state, attempt.id, attempt.readProgress!.head);
    originals.set(attempt.id, checkpoint);
    const successorId = attempt.readProgress!.successorAttemptId;
    if (successorId !== null) {
      const successor = state.attempts.find(value => value.id === successorId);
      if (!successor?.readProgress) throw new Error('read_wait_state_changed');
      const child = await checkpoints.read(state, successor.id, successor.readProgress.head);
      if (child.parent?.attemptId !== attempt.id || child.parent.checkpoint.id !== attempt.readProgress!.head.id)
        throw new Error('read_wait_state_changed');
      continue;
    }
    if (checkpoint.phase !== 'partial') continue;
    if (!task || task.readResume?.attemptId === attempt.id || checkpoint.queryDigest === queryDigest(task, services.digester))
      verified.push({ attemptId: attempt.id, queryDigest: checkpoint.queryDigest, retryAt: checkpoint.retryAt ?? null,
        remainingCalls: checkpoint.limits.maxCalls - checkpoint.calls.length });
  }
  if (selected.length) {
    const fresh = await services.state.get(state.id);
    if (!fresh || services.digester.digest(asJson(fresh)) !== services.digester.digest(asJson(state)) ||
      registration.some(({ attempt, entry }) => !entry || contracts.get(attempt.toolId, attempt.toolVersion) !== entry))
      throw new Error('read_wait_state_changed');
  }
  return { waits: verified, checkpoints: originals };
}

export async function validateReadWaits(services: RuntimeServices, contracts: ToolContracts, state: WorkState, task?: TaskSpec) {
  return (await inspectReadWaits(services, contracts, state, task)).waits;
}

/** Authenticated values for this read boundary only; callers must revalidate after state changes. */
export async function readReadyCheckpoints(services: RuntimeServices, contracts: ToolContracts, state: WorkState,
  task: TaskSpec): Promise<ReadonlyMap<string, ReadCheckpoint>> {
  const inspected = await inspectReadWaits(services, contracts, state, task);
  if (inspected.waits.some(wait => wait.retryAt !== null && services.clock.now() < wait.retryAt)) throw new Error('read_retry_not_due');
  return inspected.checkpoints;
}

export async function assertReadWaitReady(services: RuntimeServices, contracts: ToolContracts, state: WorkState, task: TaskSpec): Promise<void> {
  await readReadyCheckpoints(services, contracts, state, task);
}
