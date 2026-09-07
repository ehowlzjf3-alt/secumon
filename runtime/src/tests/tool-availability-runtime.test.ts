import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { ConversationService } from '../application/conversation-service.js';
import { OutboxDispatcher } from '../application/outbox.js';
import { WorkflowRuntime } from '../application/workflow-runtime.js';
import { ToolContracts } from '../application/tool-contracts.js';
import type { Tool } from '../application/ports.js';
import type { TaskSpec } from '../domain/model.js';
import { toolExecution } from '../application/tool-execution-usage.js';
import { createExecutionAuthority } from '../application/execution-authority.js';
import { createMcpResponseCustodyFixture } from './mcp-response-custody-fixture.js';

async function setup(t: TestContext, backend: 'sqlite' | 'file-journal' = 'sqlite', independent = false) {
  const f = await createMcpResponseCustodyFixture(t, backend);
  const task: TaskSpec = { id: 'read', description: 'Read the selected record', toolId: f.tool.definition.id, toolVersion: f.tool.definition.version,
    input: { id: 'good' }, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [] };
  let independentCalls = 0;
  if (independent) {
    const tool: Tool = { definition: { id: 'independent.read', provider: 'independent', version: '1', description: 'Local independent work', effect: 'read',
      destination: 'local', labels: ['synthetic'], inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' } },
      async execute(_task, c) { independentCalls++; return { resultId: 'independent:' + c.attemptId, attemptId: c.attemptId,
        status: 'success', effectState: 'none', coverage: 'complete', evidence: [], artifacts: [], output: {}, cursor: null, error: null }; } };
    f.contracts.replaceProvider('independent', [tool], { expectedEpoch: 0, sourceRevision: '1' });
    await f.mutate(state => { state.policy.allowedTools.push(tool.definition.id); });
  }
  const current = await f.current();
  const tasks = [task, ...(independent ? [{ ...task, id: 'local', toolId: 'independent.read', toolVersion: '1', input: {} }] : [])];
  await f.runtime.submitPlan(f.work.id, 'availability-plan', { baseStateRevision: current.revision, baseGoalRevision: current.goal.revision,
    basePlanRevision: 0, reason: 'Verify connection waits without replacing task identity', tasks, hypotheses: [] });
  const replace = (stored: boolean) => f.contracts.replaceProvider('fixture', [{ ...f.tool, availability: stored ? 'stored_only' : 'available' }],
    { expectedEpoch: f.contracts.providerEpoch('fixture'), sourceRevision: 'availability-' + f.contracts.revision });
  const workflow = (runtime = f.runtime) => new WorkflowRuntime(f.services, runtime, null, new ConversationService(f.services), new OutboxDispatcher(f.services, runtime.owner));
  return { ...f, actor: { tenantId: f.work.policy.tenantId, principalId: f.work.policy.principalId }, task, replace, workflow, independentCalls: () => independentCalls };
}

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`${backend}: a stored-only task yields a final workflow connection wait with no reservation or invocation`, async t => {
    const f = await setup(t, backend); f.replace(true); const before = await f.current();
    await assert.rejects(f.runtime.reserve(f.work.id, f.task.id), /tool_connection_required/);
    assert.deepEqual(await f.current(), before);
    const result = await f.workflow().run(f.work.id, f.actor, { maxSteps: 3 });
    assert.deepEqual(result.control, { kind: 'wait', reason: 'connection_required', wakeAt: null });
    const state = await f.current(); assert.equal(state.status, 'waiting'); assert.equal(state.attempts.length, 0);
    assert.deepEqual(state.budget, before.budget); assert.equal(f.counters.calls, 0);
    assert.equal((await f.services.state.events(f.work.id, 0)).filter(e => e.type === 'attempt_reserved').length, 0);
  });

  test(`${backend}: an unavailable ready task does not starve independent work`, async t => {
    const f = await setup(t, backend, true); f.replace(true);
    const result = await f.workflow().run(f.work.id, f.actor, { maxSteps: 8 });
    assert.equal(result.control.kind, 'wait'); assert.equal(result.control.reason, 'connection_required');
    const state = await f.current(); assert.equal(state.attempts.length, 1); assert.equal(state.attempts[0]!.taskId, 'local');
    assert.equal(state.attempts[0]!.adopted, true); assert.equal(state.budget.used.toolCalls, 1); assert.equal(state.budget.reservedToolCalls, 0);
    assert.equal(f.counters.calls, 0); assert.equal(f.independentCalls(), 1);
  });

  test(`${backend}: a stored-only reopen preserves an unsent reservation and online resume dispatches it once`, async t => {
    const f = await setup(t, backend), attempt = await f.runtime.reserve(f.work.id, f.task.id); await f.reopen();
    const contracts = new ToolContracts([{ ...f.tool, availability: 'stored_only' }], f.schemas);
    const runtime = new ExecutionRuntime(f.services, contracts, attempt.owner, 5000), before = await f.current();
    const result = await f.workflow(runtime).run(f.work.id, f.actor, { maxSteps: 3 });
    assert.deepEqual(result.control, { kind: 'wait', reason: 'connection_required', wakeAt: attempt.leaseUntil });
    const waiting = await f.current(); assert.deepEqual(waiting.attempts, before.attempts); assert.deepEqual(waiting.budget, before.budget);
    await assert.rejects(runtime.dispatch(f.work.id, attempt.id), /tool_connection_required/);
    assert.equal(await f.services.state.receipt(f.work.id, 'dispatch:' + attempt.id), null);
    contracts.replaceProvider('fixture', [f.tool], { expectedEpoch: 1, sourceRevision: 'online' });
    assert.equal((await runtime.step(f.work.id)).reason, 'intent_reserved');
    await runtime.step(f.work.id);
    const resumed = await f.current(); assert.equal(resumed.attempts.length, 1); assert.equal(resumed.attempts[0]!.id, attempt.id);
    assert.equal(resumed.attempts[0]!.adopted, true); assert.equal(resumed.budget.used.toolCalls, 1); assert.equal(resumed.budget.reservedToolCalls, 0);
    assert.equal(f.counters.calls, 1);
  });

  test(`${backend}: offline reservation expiry returns capacity without using an execution attempt`, async t => {
    const f = await setup(t, backend), attempt = await f.runtime.reserve(f.work.id, f.task.id); f.replace(true); f.setNow(attempt.leaseUntil);
    assert.equal((await f.runtime.step(f.work.id)).reason, 'lease_expired');
    const expired = await f.current(); assert.equal(expired.attempts[0]!.error?.code, 'reservation_expired');
    assert.equal(expired.budget.used.toolCalls, 0); assert.equal(expired.budget.reservedToolCalls, 0);
    assert.equal((await f.runtime.step(f.work.id)).reason, 'connection_required');
    f.replace(false); const next = await f.runtime.reserve(f.work.id, f.task.id); assert.notEqual(next.id, attempt.id);
    assert.equal(f.counters.calls, 0);
  });

  test(`${backend}: received results remain adoptable after availability changes`, async t => {
    const f = await setup(t, backend), attempt = await f.runtime.reserve(f.work.id, f.task.id);
    await f.runtime.execute(f.work.id, attempt.id); const received = await f.current(); assert.equal(received.attempts[0]!.status, 'received');
    f.replace(true); assert.equal((await f.runtime.step(f.work.id)).reason, 'stored_result_pending');
    const adopted = await f.current(); assert.equal(adopted.attempts[0]!.adopted, true); assert.equal(f.counters.calls, 1);
    assert.deepEqual(adopted.attempts[0]!.execution, received.attempts[0]!.execution);
  });
}

for (const action of ['reserve', 'dispatch'] as const) test(`availability changed after ${action} staging cannot publish a reservation or charge`, async t => {
  const f = await setup(t); const attempt = action === 'dispatch' ? await f.runtime.reserve(f.work.id, f.task.id) : null;
  const ref = await f.services.artifacts.put(new TextEncoder().encode('test publication boundary'),
    { tenantId: f.work.policy.tenantId, labels: ['synthetic'], mediaType: 'text/plain' });
  await f.mutate(state => { state.artifacts.push(ref); }); const before = await f.current();
  let staged = false, switched = false;
  const receipt = f.services.state.receipt.bind(f.services.state), exists = f.services.artifacts.exists.bind(f.services.artifacts);
  f.services.state.receipt = async (workId, commandId) => { const result = await receipt(workId, commandId); if (commandId.startsWith(action + ':')) staged = true; return result; };
  f.services.artifacts.exists = async value => { const result = await exists(value); if (staged && !switched) { switched = true; f.replace(true); } return result; };
  await assert.rejects(action === 'reserve' ? f.runtime.reserve(f.work.id, f.task.id) : f.runtime.dispatch(f.work.id, attempt!.id), /tool_connection_required/);
  assert.equal(switched, true); assert.deepEqual(await f.current(), before); assert.equal(f.counters.calls, 0);
});

for (const code of ['reservation_expired', 'reservation_cancelled']) test(`a dispatched failure named ${code} still consumes maxAttempts`, async t => {
  const f = await setup(t), attempt = await f.runtime.reserve(f.work.id, f.task.id); await f.runtime.dispatch(f.work.id, attempt.id);
  await f.mutate(state => { const current = state.attempts[0]!; current.status = 'failed'; current.finishedAt = 1100;
    current.execution = toolExecution('unreported'); current.error = { code, retryable: true }; });
  const control = f.runtime.control(await f.current()); assert.equal(control.kind, 'replan');
  await assert.rejects(f.runtime.reserve(f.work.id, f.task.id), /task_not_ready/);
  assert.equal((await f.current()).attempts.length, 1); assert.equal((await f.current()).budget.used.toolCalls, 1);
});

test('a received plain read without restoration still settles its rejection after host authority is revoked', async t => {
  const f = await setup(t), controller = new AbortController();
  const ordinary: Tool = { ...f.tool }; delete ordinary.restoreResult;
  f.contracts.replaceProvider('fixture', [ordinary], {
    expectedEpoch: f.contracts.providerEpoch('fixture'), sourceRevision: 'ordinary-read-without-restoration' });
  assert.equal(f.contracts.get(f.task.toolId, f.task.toolVersion)!.tool.restoreResult, undefined);
  f.services.executionAuthority = createExecutionAuthority({ actor: { ...f.work.policy }, scope: f.work.goal.scope, signal: controller.signal });
  const reserved = await f.runtime.reserve(f.work.id, f.task.id);
  await f.runtime.execute(f.work.id, reserved.id); await f.runtime.settlePending(reserved.id);
  const before = await f.current(), received = before.attempts.find(value => value.id === reserved.id)!;
  assert.equal(received.status, 'received'); assert.ok(received.resultArtifact);
  assert.equal(received.execution?.usage.transportCalls, 1); assert.equal(f.counters.calls, 1);
  const originalBytes = await f.services.artifacts.get(received.resultArtifact, before.policy);
  const receipt = await f.services.state.receipt(f.work.id, `receive:${reserved.id}`); assert.ok(receipt);
  const counters = { ...f.counters };
  controller.abort(new Error('host authority revoked after receive'));
  assert.deepEqual(await f.runtime.step(f.work.id), { kind: 'continue', action: 'adopt', id: reserved.id, reason: 'stored_result_pending' });
  const after = await f.current(), rejected = after.attempts.find(value => value.id === reserved.id)!;
  assert.deepEqual(rejected, { ...received, status: 'failed', adopted: false, error: { code: 'result_permission_revoked', retryable: false } });
  assert.deepEqual(after.budget, before.budget); assert.deepEqual(after.evidence, before.evidence);
  assert.deepEqual(await f.services.state.receipt(f.work.id, `receive:${reserved.id}`), receipt);
  assert.deepEqual(await f.services.artifacts.get(rejected.resultArtifact!, after.policy), originalBytes);
  assert.deepEqual(f.counters, counters, 'rejecting a received result does not call the source or projector again');
});
