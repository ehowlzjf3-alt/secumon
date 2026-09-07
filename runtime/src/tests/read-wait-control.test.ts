import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskSpec } from '../domain/model.js';
import { decideExecution } from '../application/execution-decision.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { artifact, attempt, initial } from './state-conformance-helpers.js';

function fixture() {
  const state = initial(); const digester = new Sha256Digester();
  const task: TaskSpec = { id: 'resume', description: 'Continue the same selected records', toolId: 'fixture.read', toolVersion: '1',
    input: { id: 'a' }, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [],
    readResume: { attemptId: 'parent', checkpointId: 'synthetic-input' } };
  state.plan = { revision: 2, goalRevision: 1, reason: 'Explicitly resume later', tasks: [task] };
  state.attempts = [{ ...attempt('partial'), id: 'parent', taskId: 'original', adopted: true, finishedAt: 1000,
    error: { code: 'read_rate_limited', retryable: false }, readProgress: { operationId: 'read-operation', head: artifact(),
      callCount: 1, remainingCalls: 5, completedPages: 0, completedItems: 1, pendingItems: 1, unknownCalls: 0, phase: 'partial', successorAttemptId: null,
      retryAt: 3500, queryDigest: digester.digest({ toolId: task.toolId, toolVersion: task.toolVersion, input: task.input }) } }];
  return { state, task, digester, decision: (now = 3499) => decideExecution(state, now, digester) };
}

test('read wait: an explicit successor stays queued before due and becomes eligible exactly at due', () => {
  const f = fixture(); assert.deepEqual(f.decision(), { kind: 'wait', reason: 'read_retry_wait', wakeAt: 3500 });
  assert.deepEqual(f.decision(3500), { kind: 'continue', action: 'reserve', id: 'resume', reason: 'task_ready' });
  assert.equal(f.state.attempts[0]!.readProgress!.successorAttemptId, null);
});
test('read wait: a renamed fresh task cannot bypass the same work/query cooldown', () => {
  const f = fixture(); delete f.task.readResume; f.task.id = 'fresh-looking-id';
  assert.deepEqual(f.decision(), { kind: 'wait', reason: 'read_retry_wait', wakeAt: 3500 });
});
test('read wait: an independent query runs while the first task is waiting', () => {
  const f = fixture(); f.state.status = 'waiting'; f.state.statusReason = 'read_retry_wait'; f.state.retryWakeAt = 3500;
  f.state.plan!.tasks.push({ ...f.task, id: 'independent', input: { id: 'other' }, readResume: undefined });
  assert.deepEqual(f.decision(), { kind: 'continue', action: 'reserve', id: 'independent', reason: 'task_ready' });
});
test('read wait: waiting prevents replanning even when no successor has been proposed', () => {
  const f = fixture(); f.state.plan!.tasks = []; f.state.retryWakeAt = null;
  assert.deepEqual(f.decision(), { kind: 'wait', reason: 'read_retry_wait', wakeAt: 3500 });
  assert.equal(f.decision(3500).kind, 'replan');
});
test('read wait: clearing the wake projection or pausing does not reset the original retry time', () => {
  const f = fixture(); f.state.status = 'paused'; f.state.statusReason = 'user_pause'; f.state.retryWakeAt = null;
  assert.deepEqual(f.decision(), { kind: 'paused', reason: 'user_pause' });
  f.state.status = 'ready'; f.state.statusReason = 'user_resume';
  assert.deepEqual(f.decision(), { kind: 'wait', reason: 'read_retry_wait', wakeAt: 3500 });
});
test('read wait: the work deadline wakes earlier than the retry time and then blocks input', () => {
  const f = fixture(); f.state.deadlineAt = 3000;
  assert.deepEqual(f.decision(2999), { kind: 'wait', reason: 'read_retry_wait', wakeAt: 3000 });
  assert.deepEqual(f.decision(3000), { kind: 'blocked', reason: 'deadline_exceeded' });
});
test('read wait: cancelled work stays cancelled and a new goal does not inherit old query waits', () => {
  const f = fixture(); f.state.status = 'cancelled'; f.state.statusReason = 'user_cancelled';
  assert.deepEqual(f.decision(), { kind: 'cancelled', reason: 'user_cancelled' });
  f.state.status = 'ready'; f.state.goal.revision = 2; f.state.plan!.goalRevision = 2;
  assert.equal(f.decision().kind, 'continue');
});
test('read wait: a depleted collection call allowance never creates another early call', () => {
  const f = fixture(); f.state.attempts[0]!.readProgress!.remainingCalls = 0;
  assert.deepEqual(f.decision(), { kind: 'blocked', reason: 'read_call_limit' });
});
