import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationService } from '../application/conversation-service.js';
import { createExecutionAuthority, type ExecutionAuthority } from '../application/execution-authority.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { OutboxDispatcher } from '../application/outbox.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { summarizeToolExecution } from '../application/tool-execution-usage.js';
import { WorkflowRuntime } from '../application/workflow-runtime.js';
import type { WorkActor } from '../application/work-resources.js';
import { createMcpResponseCustodyFixture, type McpResponseCustodyFixture } from './mcp-response-custody-fixture.js';

function open(f: McpResponseCustodyFixture) {
  const runtime = new ExecutionRuntime(f.services, new ToolContracts([f.reader()], f.schemas), 'reopened-workflow');
  const workflow = new WorkflowRuntime(f.services, runtime, null, new ConversationService(f.services), new OutboxDispatcher(f.services, runtime.owner));
  const actor: WorkActor = { tenantId: f.work.policy.tenantId, principalId: f.work.policy.principalId };
  return { runtime, workflow, actor };
}

for (const ending of ['cancel', 'expire'] as const) test(`an untransmitted ${ending} reservation is not treated as a lost dispatch during reconciliation`, async t => {
  const f = await createMcpResponseCustodyFixture(t), { attempt } = await f.prepare({ dispatch: false });
  const { workflow, actor } = open(f);
  if (ending === 'cancel') await f.runtime.command(f.work.id, 'cancel-before-dispatch', actor, f.work.goal.revision,
    { kind: 'cancel', reason: 'operator_cancelled_before_dispatch' });
  else { f.setNow(attempt.leaseUntil); await f.runtime.recover(f.work.id, attempt.id); }
  const before = await f.current(); let rawReads = 0;
  assert.equal(before.attempts[0]!.execution?.mode, 'not_invoked');
  assert.equal(before.attempts[0]!.error?.code, ending === 'cancel' ? 'reservation_cancelled' : 'reservation_expired');
  const get = f.services.artifacts.get.bind(f.services.artifacts);
  f.services.artifacts.get = async (...args) => { rawReads++; return get(...args); };
  const recovered = await workflow.reconcileUsage(f.work.id, actor);
  assert.equal(recovered.inspected, 0); assert.deepEqual(recovered.changed, []);
  assert.equal(rawReads, 0); assert.deepEqual(await f.current(), before);
  assert.equal(before.budget.used.toolCalls, 0); assert.equal(before.budget.reservedToolCalls, 0);
  assert.equal(summarizeToolExecution(before).notInvoked, 0);
  assert.equal(summarizeToolExecution(before).unknownInvocations, 0);
  assert.equal(f.counters.calls, 0); assert.equal(f.counters.projections, 0);
  assert.equal(await f.services.state.receipt(f.work.id, `dispatch:${attempt.id}`), null);
  assert.equal((await f.services.state.events(f.work.id, 0)).filter(event => event.type === 'tool_execution_usage_recorded').length, 0);
});

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`${backend}: ordinary workflow resume records protected custody once and preserves cancellation without inference`, async t => {
    const f = await createMcpResponseCustodyFixture(t, backend), { attempt } = await f.prepare();
    f.controls.afterCapture = () => f.mutate(state => {
      state.policy.allowedLabels = []; state.status = 'cancelled'; state.statusReason = 'operator_cancelled';
    });
    await assert.rejects(f.invoke(attempt.id), /broker_execution_not_current/);
    const response = await f.response(attempt.id); assert.ok(response);
    const ref = f.rawRef()!, original = await f.raw(ref), before = await f.current();
    assert.equal(before.attempts[0]!.execution?.mode, 'unreported');
    await f.reopen(); const { workflow, actor } = open(f);
    const run = await workflow.run(f.work.id, actor, { maxSteps: 3 });
    assert.equal(run.control.kind, 'cancelled');
    const after = await f.current();
    assert.equal(after.status, 'cancelled'); assert.equal(after.statusReason, 'operator_cancelled');
    assert.equal(after.attempts[0]!.owner, attempt.owner); assert.equal(after.attempts[0]!.leaseUntil, attempt.leaseUntil);
    assert.equal(after.attempts[0]!.execution?.usage.transportCalls, 1);
    assert.equal(after.attempts[0]!.resultArtifact, null); assert.equal(after.attempts[0]!.adopted, false);
    assert.deepEqual(after.goal, before.goal); assert.deepEqual(after.plan, before.plan); assert.deepEqual(after.budget, before.budget);
    assert.equal(after.evidence.length, 0); assert.equal(after.modelCalls.length, 0);
    assert.equal(f.counters.calls, 1); assert.equal(f.counters.discoveries, 0); assert.equal(f.counters.projections, 0);
    assert.deepEqual(await f.response(attempt.id), response); assert.deepEqual(await f.raw(ref), original);
    let rawReads = 0; const get = f.services.artifacts.get.bind(f.services.artifacts);
    f.services.artifacts.get = async (...args) => { if (args[0].id === ref.id) rawReads++; return get(...args); };
    const duplicate = await workflow.reconcileUsage(f.work.id, actor);
    assert.deepEqual(duplicate.changed, []); assert.equal(rawReads, 0, 'a matching usage receipt skips the nullable original without reading raw');
    assert.deepEqual(await f.current(), after);
    assert.equal((await f.services.state.events(f.work.id, 0)).filter(event => event.type === 'tool_execution_usage_recorded').length, 1);
  });
}

test('custody ownership accepts a revoked narrower host while ordinary execution still refuses its broader persisted policy', async t => {
  const f = await createMcpResponseCustodyFixture(t), { attempt } = await f.prepare();
  f.controls.callMode = 'captured-failure'; await assert.rejects(f.invoke(attempt.id), error => error === f.errors.captured);
  const signal = new AbortController(), actor: WorkActor = { ...f.work.policy, allowedLabels: [] };
  f.services.executionAuthority = createExecutionAuthority({ actor, scope: f.work.goal.scope, signal: signal.signal }); signal.abort();
  const { workflow } = open(f); let rawReads = 0;
  const get = f.services.artifacts.get.bind(f.services.artifacts);
  f.services.artifacts.get = async (...args) => { rawReads++; return get(...args); };
  await assert.rejects(workflow.run(f.work.id, actor), /workflow_policy_insufficient/); assert.equal(rawReads, 0);
  const recovered = await workflow.reconcileUsage(f.work.id, actor);
  assert.deepEqual(recovered.changed, [attempt.id]); assert.ok(rawReads > 0);
  const current = await f.current(); assert.equal(current.attempts[0]!.execution?.usage.transportCalls, 1);
  assert.equal(current.attempts[0]!.resultArtifact, null); assert.equal(current.evidence.length, 0);
  assert.equal(f.counters.projections, 0); assert.equal(f.counters.calls, 1);
});

test('foreign actor, wrong host scope and unissued host authority cannot start a custody proof', async t => {
  const f = await createMcpResponseCustodyFixture(t), { attempt } = await f.prepare();
  f.controls.callMode = 'captured-failure'; await assert.rejects(f.invoke(attempt.id), error => error === f.errors.captured);
  const { workflow, actor } = open(f), before = await f.current(); let rawReads = 0;
  const get = f.services.artifacts.get.bind(f.services.artifacts);
  f.services.artifacts.get = async (...args) => { rawReads++; return get(...args); };
  await assert.rejects(workflow.reconcileUsage(f.work.id, { ...actor, principalId: 'another-person' }), /work_unavailable/);
  f.services.executionAuthority = createExecutionAuthority({ actor: f.work.policy, scope: 'another-scope', signal: new AbortController().signal });
  await assert.rejects(workflow.reconcileUsage(f.work.id, actor), /execution_custody_denied/);
  f.services.executionAuthority = { actor: f.work.policy, scope: f.work.goal.scope, signal: new AbortController().signal } as ExecutionAuthority;
  await assert.rejects(workflow.reconcileUsage(f.work.id, actor), /execution_custody_denied/);
  assert.equal(rawReads, 0); assert.deepEqual(await f.current(), before);
});

test('a replaced work incarnation during the proof cannot receive the selected workflow accounting commit', async t => {
  const f = await createMcpResponseCustodyFixture(t), { attempt } = await f.prepare();
  f.controls.callMode = 'captured-failure'; await assert.rejects(f.invoke(attempt.id), error => error === f.errors.captured);
  const { workflow, actor } = open(f), get = f.services.artifacts.get.bind(f.services.artifacts); let changed = false;
  f.services.artifacts.get = async (...args) => {
    const bytes = await get(...args);
    if (!changed) { changed = true; await f.mutate(state => { state.createdAt++; }); }
    return bytes;
  };
  await assert.rejects(workflow.reconcileUsage(f.work.id, actor), /work_unavailable/);
  assert.equal((await f.current()).attempts[0]!.execution?.mode, 'unreported');
  assert.equal((await f.services.state.events(f.work.id, 0)).filter(event => event.type === 'tool_execution_usage_recorded').length, 0);
});
