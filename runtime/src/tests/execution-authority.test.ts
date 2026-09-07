import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutionAuthority, executionAuthorityCurrent } from '../application/execution-authority.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { PlanningRuntime } from '../application/planning-runtime.js';
import { WorkflowRuntime } from '../application/workflow-runtime.js';
import { ConversationService } from '../application/conversation-service.js';
import { ContextRecovery } from '../application/context-recovery.js';
import { OutboxDispatcher } from '../application/outbox.js';
import { ToolBroker } from '../application/tool-broker.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { transact } from '../application/work-transactions.js';
import type { RuntimeServices } from '../application/services.js';
import type { ModelReply, MessageSink } from '../application/ports.js';
import type { ContextPacket, Policy } from '../domain/model.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FakeClock, FakeSink, FixtureReadTool } from '../infrastructure/fakes.js';
import { ScriptedPlanner } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { scenario, request as baseRequest } from './session-flow-helpers.js';
import { initialize, openCompact, seedCompletedXAndActiveY } from './session-compact-flow-helpers.js';

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const identity = { tenantId: scenario.policy.tenantId, principalId: scenario.policy.principalId };
const proposal = (packet: ContextPacket): ModelReply => ({ status: 'ok', provider: 'scripted', model: 'fixture', inputTokens: 100, outputTokens: 30,
  proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
    reason: 'Deterministic authority boundary fixture', hypotheses: [], tasks: [{ id: 'read', description: 'Read the declared original', dependsOn: [],
      toolId: 'fixture.read', toolVersion: '1', input: { evidenceIds: ['doc-current'] }, effect: 'read', maxAttempts: 2, satisfies: packet.goal.criteria.map(c => c.id) }] } });

async function fixture(t: TestContext, options: { lease?: boolean; sink?: MessageSink; ceiling?: Policy; tool?: FixtureReadTool } = {}) {
  const controller = new AbortController(); const actor = structuredClone(options.ceiling ?? scenario.policy);
  const planner = new ScriptedPlanner([proposal]); const tool = options.tool ?? new FixtureReadTool(scenario.evidence);
  const services: RuntimeServices = { state: new MemoryStateRepository(), artifacts: new MemoryArtifactStore(), clock: new FakeClock(1788566400000),
    ids: new RandomIds(), digester: new Sha256Digester(), planner, tools: [tool], sink: options.sink ?? new FakeSink(),
    ...(options.lease === false ? {} : { executionAuthority: createExecutionAuthority({ actor, scope: scenario.goal.scope, signal: controller.signal, disclosure: actor.disclosure }) }) };
  t.after(async () => { await services.state.close(); });
  const tools = new ToolContracts([tool], new AjvSchemas()); const conversation = new ConversationService(services);
  const execution = new ExecutionRuntime(services, tools, 'authority-owner'); const planning = new PlanningRuntime(services, tools, execution, execution.owner);
  const outbox = new OutboxDispatcher(services, execution.owner); const recovery = new ContextRecovery(services, tools);
  const workflow = new WorkflowRuntime(services, execution, planning, conversation, outbox, recovery);
  const accepted = await conversation.accept(identity, baseRequest('authority-request'));
  const workId = accepted.workId;
  const preparedTool = async () => {
    const state = await execution.state(workId), reply = proposal({ stateRevision: state.revision, goal: state.goal, plan: state.plan } as ContextPacket);
    assert.equal(reply.status, 'ok'); if (reply.status !== 'ok') throw new Error('fixture_reply');
    await execution.submitPlan(workId, 'direct-fixture-plan', reply.proposal);
    return execution.reserve(workId, 'read');
  };
  return { services, controller, actor, planner, tool, tools, execution, planning, outbox, recovery, workflow, workId, preparedTool };
}

test('authority copies full actor and disclosure, rejects fabricated references and revoked scopes', () => {
  const actor = structuredClone(scenario.policy); const controller = new AbortController();
  const disclosure = { revision: 'host-1', destinations: [{ destination: 'local', surfaces: ['model' as const], allowedLabels: ['synthetic'] }], maxReleasesPerWork: 1, maxReleasedBytesPerWork: 1024 };
  const authority = createExecutionAuthority({ actor, scope: scenario.goal.scope, signal: controller.signal, disclosure });
  actor.allowedTools.push('foreign.tool'); disclosure.destinations[0]!.surfaces.length = 0;
  assert.deepEqual(authority.actor.allowedTools, scenario.policy.allowedTools); assert.deepEqual(authority.disclosure!.destinations[0]!.surfaces, ['model']);
  assert.ok(Object.isFrozen(authority.actor.allowedTools)); assert.ok(Object.isFrozen(authority.disclosure!.destinations[0]!.surfaces));
  const basis = { policy: { ...scenario.policy, disclosure: structuredClone(authority.disclosure!) }, goal: scenario.goal };
  assert.equal(executionAuthorityCurrent({ executionAuthority: authority }, basis), true);
  assert.equal(executionAuthorityCurrent({ executionAuthority: authority }, { ...basis, policy: { ...basis.policy,
    disclosure: { ...basis.policy.disclosure, maxReleasedBytesPerWork: 2048 } } }), false);
  assert.equal(executionAuthorityCurrent({ executionAuthority: authority }, { ...basis, policy: { ...basis.policy,
    disclosure: { ...basis.policy.disclosure, destinations: [{ ...basis.policy.disclosure.destinations[0]!, surfaces: ['model', 'channel'] }] } } }), false);
  assert.equal(executionAuthorityCurrent({ executionAuthority: { ...authority } }, basis), false);
  assert.equal(executionAuthorityCurrent({ executionAuthority: authority }, { ...basis, goal: { ...basis.goal, scope: 'another' } }), false);
  controller.abort(); assert.equal(executionAuthorityCurrent({ executionAuthority: authority }, basis), false);
  assert.throws(() => createExecutionAuthority({ actor: identity, scope: scenario.goal.scope, signal: controller.signal }), /invalid_execution_authority/);
});

test('full scoped workflow runs with a lease while the legacy scoped guard remains', async t => {
  const f = await fixture(t); const result = await f.workflow.run(f.workId, f.actor);
  assert.equal(result.control.kind, 'complete'); assert.equal(f.planner.inputs.length, 1); assert.equal(f.tool.invocations.length, 1);
  const legacy = await fixture(t, { lease: false });
  await assert.rejects(legacy.workflow.run(legacy.workId, legacy.actor), /workflow_scoped_execution_not_supported/);
  assert.equal(legacy.planner.inputs.length, 0); assert.equal(legacy.tool.invocations.length, 0);
});

for (const narrowed of ['tools', 'disclosure'] as const) test(`reopen with narrower ${narrowed} authority refuses raw stored policy without hiding read-only state`, async t => {
  const ceiling = structuredClone(scenario.policy);
  if (narrowed === 'tools') ceiling.allowedTools = [];
  else ceiling.disclosure = { revision: 'narrower', destinations: [], maxReleasesPerWork: 0, maxReleasedBytesPerWork: 0 };
  const f = await fixture(t, { ceiling });
  await assert.rejects(f.planning.reserve(f.workId), /execution_authority_denied/);
  await assert.rejects(f.recovery.restore(f.workId, identity), /execution_authority_denied/);
  assert.deepEqual((await f.execution.state(f.workId)).policy, scenario.policy);
  assert.equal(f.planner.inputs.length, 0); assert.equal(f.tool.invocations.length, 0);
});

for (const change of ['abort', 'policy'] as const) test(`model preflight ${change} after source validation invokes no provider`, async t => {
  const f = await fixture(t); const call = await f.planning.reserve(f.workId); const original = f.planning.context.sourcesCurrent.bind(f.planning.context);
  let intercepted = false;
  f.planning.context.sourcesCurrent = async (...args) => {
    const valid = await original(...args);
    if (!intercepted) {
      intercepted = true;
      if (change === 'abort') f.controller.abort();
      else await transact(f.services, f.workId, 'expand-policy-in-preflight', 'policy_changed', {}, state => { state.policy.allowedTools.push('forbidden.tool'); });
    }
    return valid;
  };
  await f.planning.execute(f.workId, call.id); assert.equal(intercepted, true); assert.equal(f.planner.inputs.length, 0);
  assert.equal(await f.planning.adopt(f.workId, call.id), false);
  const state = await f.execution.state(f.workId); assert.equal(state.budget.used.tokens, 0); assert.equal(state.modelCalls[0]!.inputTokens, 0);
});

test('late model reply retains reported usage after revocation and cannot be adopted', async t => {
  const f = await fixture(t); const entered = gate(), release = gate(); let invocations = 0;
  f.planner.propose = async packet => { invocations++; entered.resolve(); await release.promise; return proposal(packet); };
  const call = await f.planning.reserve(f.workId); const running = f.planning.execute(f.workId, call.id);
  await entered.promise; f.controller.abort(); await running;
  release.resolve(); assert.deepEqual(await f.planning.settlePending(), []);
  const state = await f.execution.state(f.workId), current = state.modelCalls[0]!;
  assert.equal(invocations, 1); assert.equal(current.usageStatus, 'reported'); assert.equal(current.inputTokens, 100); assert.equal(current.outputTokens, 30);
  assert.equal(state.budget.used.tokens, 130); assert.equal(state.budget.reservedTokens, 0);
  assert.equal(await f.planning.adopt(f.workId, call.id), false); assert.equal((await f.execution.state(f.workId)).plan, null);
  const reply = JSON.parse(Buffer.from(await f.services.artifacts.get(current.replyArtifact!, state.policy)).toString());
  assert.equal(reply.status, 'error'); assert.equal(reply.code, 'model_authorization_changed'); assert.equal(reply.proposal, undefined);
});

for (const phase of ['reply_put', 'before_commit'] as const) test(`abort during ${phase} retries settlement once without preserving an adoptable body for a new lease`, async t => {
  const f = await fixture(t); const call = await f.planning.reserve(f.workId);
  const put = f.services.artifacts.put.bind(f.services.artifacts), exists = f.services.artifacts.exists.bind(f.services.artifacts);
  let intercepted = false, replyId: string | undefined;
  f.services.artifacts.put = async (...args) => {
    const ref = await put(...args); const body = JSON.parse(Buffer.from(args[0]).toString());
    if (body.status === 'ok' && body.proposal) {
      replyId = ref.id;
      if (phase === 'reply_put' && !intercepted) { intercepted = true; f.controller.abort(); }
    }
    return ref;
  };
  f.services.artifacts.exists = async ref => {
    const value = await exists(ref);
    if (phase === 'before_commit' && ref.id === replyId && !intercepted) { intercepted = true; f.controller.abort(); }
    return value;
  };
  await f.planning.execute(f.workId, call.id); assert.deepEqual(await f.planning.settlePending(), []);
  const state = await f.execution.state(f.workId), saved = state.modelCalls[0]!;
  assert.equal(intercepted, true); assert.equal(f.planner.inputs.length, 1);
  assert.equal(saved.usageStatus, 'reported'); assert.equal(saved.inputTokens, 100); assert.equal(saved.outputTokens, 30);
  assert.equal(state.budget.used.tokens, 130); assert.equal(state.budget.reservedTokens, 0); assert.equal(state.budget.used.unmeasuredModelCalls, 0);
  assert.equal((await f.services.state.events(f.workId, 0)).filter(event => event.type === 'model_reply_received').length, 1);
  f.services.executionAuthority = createExecutionAuthority({ actor: f.actor, scope: state.goal.scope, signal: new AbortController().signal });
  assert.equal(await f.planning.adopt(f.workId, call.id), false);
  const stored = JSON.parse(Buffer.from(await f.services.artifacts.get(saved.replyArtifact!, state.policy)).toString());
  assert.equal(stored.status, 'error'); assert.equal(stored.code, 'model_authorization_changed'); assert.equal(stored.proposal, undefined);
  assert.equal((await f.execution.state(f.workId)).budget.used.tokens, 130);
});

for (const change of ['abort', 'policy'] as const) test(`tool preflight ${change} during an async reuse miss invokes no tool`, async t => {
  const f = await fixture(t), attempt = await f.preparedTool(); assert.equal(await f.execution.dispatch(f.workId, attempt.id), true);
  const entered = gate(), release = gate();
  const broker = new ToolBroker(f.services.state, f.tools, f.services.digester, f.services.clock, undefined, undefined, undefined, f.services);
  const running = broker.invoke(f.workId, attempt.id, f.execution.owner, new AbortController().signal, { reuse: async () => { entered.resolve(); await release.promise; return null; } });
  const rejected = assert.rejects(running, /broker_execution_not_current|execution_authority_denied/);
  await entered.promise;
  if (change === 'abort') f.controller.abort();
  else await transact(f.services, f.workId, 'policy-during-reuse', 'policy_changed', {}, state => { state.policy.allowedTools.push('forbidden.tool'); });
  release.resolve(); await rejected; assert.equal(f.tool.invocations.length, 0);
});

test('late tool result is recorded but its evidence is not adopted after authority revocation', async t => {
  const tool = new FixtureReadTool(scenario.evidence), entered = gate(), release = gate(), execute = tool.execute.bind(tool);
  tool.execute = async (...args) => { const result = await execute(...args); entered.resolve(); await release.promise; return result; };
  const f = await fixture(t, { tool }), attempt = await f.preparedTool();
  const running = f.execution.execute(f.workId, attempt.id); await entered.promise; f.controller.abort(); await running;
  release.resolve(); await f.execution.settlePending(attempt.id);
  const received = await f.execution.state(f.workId); assert.equal(received.attempts[0]!.execution?.mode, 'invoked'); assert.ok(received.attempts[0]!.resultArtifact);
  const adopted = await f.execution.adopt(f.workId, attempt.id);
  assert.equal(adopted.attempts[0]!.adopted, false); assert.equal(adopted.attempts[0]!.error?.code, 'result_permission_revoked'); assert.deepEqual(adopted.evidence, []);
});

for (const action of ['send', 'lookup'] as const) test(`outbox ${action} checks the raw authority after asynchronous validation`, async t => {
  let sends = 0, lookups = 0;
  const sink: MessageSink = { capabilities: { idempotentSend: true }, async send() { sends++; return { status: 'unknown' }; }, async lookup() { lookups++; return { status: 'unknown' }; } };
  const f = await fixture(t, { sink });
  if (action === 'lookup') { await f.outbox.flush(f.workId, identity); assert.equal(sends, 1); }
  // Add a real bounded source artifact to the pending acknowledgement so its existence check can yield.
  const state = await f.execution.state(f.workId), delivery = (await f.services.state.deliveries(f.workId))[0]!;
  const artifact = await f.services.artifacts.put(new TextEncoder().encode('ack source'), { tenantId: identity.tenantId, labels: [], mediaType: 'text/plain' });
  await transact(f.services, f.workId, `ack-source-${action}`, 'ack_source', {}, next => {
    assert.equal(next.revision, state.revision); return [{ ...delivery, context: { ...delivery.context!, artifact } }];
  });
  const exists = f.services.artifacts.exists.bind(f.services.artifacts); let intercepted = false;
  f.services.artifacts.exists = async ref => { const result = await exists(ref); if (ref.id === artifact.id && !intercepted) { intercepted = true; f.controller.abort(); } return result; };
  await f.outbox.flush(f.workId, identity);
  assert.equal(intercepted, true); assert.equal(sends, action === 'send' ? 0 : 1); assert.equal(lookups, 0);
});

test('context recovery does not return a checkpoint when its authority is revoked during artifact publication', async t => {
  const f = await fixture(t); const put = f.services.artifacts.put.bind(f.services.artifacts); let intercepted = false;
  f.services.artifacts.put = async (...args) => { const ref = await put(...args); if (!intercepted) { intercepted = true; f.controller.abort(); } return ref; };
  await assert.rejects(f.recovery.restore(f.workId, identity), /execution_authority_denied/);
  assert.equal(intercepted, true); assert.equal(f.planner.inputs.length, 0); assert.equal(f.tool.invocations.length, 0);
});

test('real session compact uses the same revocable model boundary and keeps raw session records', async t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'compact-authority-'))); mkdirSync(join(base, 'engine'), { mode: 0o700 }); initialize(base);
  const f = await openCompact(base); t.after(async () => { await f.close(); rmSync(base, { recursive: true, force: true }); });
  const { y } = await seedCompletedXAndActiveY(f), state = await f.runtime.state(y.workId); const controller = new AbortController();
  f.services.executionAuthority = createExecutionAuthority({ actor: state.policy, scope: state.goal.scope, signal: controller.signal });
  const call = await f.compactPlanning!.requestCompact(y.workId, { requestId: 'authority-compact', force: true, expectedGoalRevision: 1 }); assert.ok(call);
  const current = f.services.sessionCompacts!.compactInputCurrent.bind(f.services.sessionCompacts!); let intercepted = false;
  f.services.sessionCompacts!.compactInputCurrent = async (...args) => { const valid = await current(...args); if (!intercepted && args[0].modelCalls.some(c => c.id === call.id && c.status === 'running')) { intercepted = true; controller.abort(); } return valid; };
  await f.compactPlanning!.execute(y.workId, call.id); assert.equal(intercepted, true); assert.equal(f.planner.inputs.length, 0);
  assert.equal(await f.compactPlanning!.adopt(y.workId, call.id), false);
  assert.equal(await f.stores.sessions.publication(state.conversation!.session!.scope, call.id), null);
  assert.deepEqual((await f.runtime.state(y.workId)).conversation!.session, state.conversation!.session);
});
