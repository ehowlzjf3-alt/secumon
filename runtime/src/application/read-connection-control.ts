import type { Control } from '../domain/control.js';
import type { WorkState } from '../domain/model.js';
import { hypothesesRequireReview } from '../domain/hypotheses.js';
import { currentAttempts, isEndedToolReservation, taskSucceeded } from '../domain/task-status.js';
import type { RuntimeServices } from './services.js';
import type { ToolContracts } from './tool-contracts.js';
import { asJson, taskDigest } from './plan-validator.js';
import { ReadCheckpoints } from './read-checkpoints.js';
import { nextRequest, ReadCollectionError } from './read-collection-validation.js';
import { assertExecutionAuthority } from './execution-authority.js';

const terminal = new Set(['partial', 'failed', 'cancelled', 'succeeded']);
const noNextRequest = new Set(['read_call_limit', 'read_page_limit', 'read_item_limit', 'read_retry_forbidden']);

/** A scheduling inspection only. It authenticates originals but never reserves, dispatches or selects a successor. */
export async function inspectReadConnectionControl(services: RuntimeServices, contracts: ToolContracts,
  supplied: WorkState, control: Control): Promise<Control> {
  if (control.kind !== 'replan' || control.reason !== 'plan_cannot_complete_goal') return control;
  const state = structuredClone(supplied), plan = state.plan;
  if (!plan || plan.goalRevision !== state.goal.revision || !['ready', 'running', 'waiting'].includes(state.status) ||
      services.clock.now() >= state.deadlineAt || hypothesesRequireReview(state) || state.conversation?.sessionReviewRequired ||
      state.personalMemoryReviewRequired || (state.notifications ?? []).some(value => plan.goalRevision !== value.goalRevision ||
        plan.revision <= value.observedPlanRevision)) return control;
  const selected = plan.tasks.flatMap(task => {
    if (task.effect !== 'read' || taskSucceeded(state, task) || !task.dependsOn.every(id => {
      const parent = plan.tasks.find(value => value.id === id); return parent !== undefined && taskSucceeded(state, parent);
    })) return [];
    const parent = currentAttempts(state, task).filter(attempt => !isEndedToolReservation(attempt)).at(-1);
    const progress = parent?.readProgress, entry = contracts.get(task.toolId, task.toolVersion);
    if (!parent || !terminal.has(parent.status) || parent.effect !== 'read' || parent.effectState !== 'none' ||
        !progress || progress.successorAttemptId !== null || progress.phase === 'complete' ||
        parent.toolId !== task.toolId || parent.toolVersion !== task.toolVersion || parent.inputDigest !== taskDigest(task, services.digester) ||
        !entry?.tool.definition.collection || contracts.checkExecution(task, state.policy) !== 'tool_connection_required') return [];
    return [{ parent, task, entry }];
  });
  if (!selected.length) return control;
  const digest = (value: unknown) => services.digester.digest(asJson(value));
  const pin = digest(state), catalogRevision = contracts.revision;
  const current = async () => {
    const latest = await services.state.get(state.id);
    if (!latest || digest(latest) !== pin || contracts.revision !== catalogRevision || selected.some(({ task, entry }) =>
      contracts.get(task.toolId, task.toolVersion) !== entry || contracts.checkExecution(task, latest.policy) !== 'tool_connection_required'))
      throw new Error('read_checkpoint_unavailable');
    assertExecutionAuthority(services, latest);
  };
  const checkpoints = new ReadCheckpoints(services, contracts);
  const retryTimes: (number | null)[] = [];
  for (const { parent, task } of selected) {
    assertExecutionAuthority(services, state);
    // read checks the original dispatch/task digest, every retained response, current policy/lifecycle and source dependencies.
    const checkpoint = await checkpoints.read(state, parent.id, parent.readProgress!.head);
    if (checkpoint.phase === 'complete' || checkpoint.collection.exhausted || checkpoint.calls.length >= checkpoint.limits.maxCalls ||
        !['accepted', 'deferred'].includes(checkpoint.calls.at(-1)?.status ?? '')) continue;
    if (checkpoint.queryDigest !== digest({ toolId: task.toolId, toolVersion: task.toolVersion, input: task.input }))
      throw new Error('read_checkpoint_unavailable');
    // A local throwaway token exercises nextRequest's shape/limit/retry rules; services.ids is never used.
    const used = new Set(checkpoint.collection.acceptedRequestIds); let index = 0;
    while (used.has(`read-connection-inspection:${index}`)) index++;
    try { if (nextRequest(checkpoint.collection, `read-connection-inspection:${index}`, checkpoint.limits) === null) continue; }
    catch (error) { if (error instanceof ReadCollectionError && noNextRequest.has(error.code)) continue; throw error; }
    retryTimes.push(checkpoint.retryAt ?? null);
  }
  await current();
  const now = services.clock.now();
  if (now >= state.deadlineAt) return control;
  const waits: Extract<Control, { kind: 'wait' }>[] = retryTimes.map(retryAt => retryAt !== null && retryAt > now
    ? { kind: 'wait', reason: 'read_retry_wait', wakeAt: Math.min(retryAt, state.deadlineAt) }
    : { kind: 'wait', reason: 'connection_required', wakeAt: null });
  return waits.sort((a, b) => (a.wakeAt ?? Infinity) - (b.wakeAt ?? Infinity))[0] ?? control;
}
