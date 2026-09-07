import test from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeServices } from '../application/services.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { ConversationService } from '../application/conversation-service.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { OutboxDispatcher } from '../application/outbox.js';
import { ToolBroker } from '../application/tool-broker.js';
import { WorkflowRuntime } from '../application/workflow-runtime.js';
import { transact } from '../application/work-transactions.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FakeClock } from '../infrastructure/fakes.js';
import { createMcpReadTool, type McpReadBinding } from '../infrastructure/mcp-read-tools.js';
import type { McpSession, McpStdioClient } from '../infrastructure/mcp-stdio-client.js';
import { MCP_FIXTURE_DOCUMENTS_TOOL, MCP_FIXTURE_PROTOCOL, fixtureRecord } from './helpers/mcp-fixture-contracts.js';
import { storedResultFixture } from './stored-result-fixture.js';
import { windowActor, windowFixture } from './session-window-helpers.js';

test('stored MCP response settles before a smaller reconnect session window needs compact and its first checkpoint', async t => {
  const f = await windowFixture(t, 5, { maxContextEntries: 8, keepRecentEntries: 1 });
  const schemas = new AjvSchemas(), clock = f.services.clock;
  assert.ok(clock instanceof FakeClock);
  let calls = 0;
  const base: RuntimeServices = { state: f.services.state, artifacts: f.services.artifacts, clock,
    ids: f.services.ids, digester: f.services.digester, sink: f.services.sink, planner: f.planner, tools: [] };
  const binding: McpReadBinding = { definition: { provider: 'fixture', id: 'fixture.read', version: '1',
    description: 'Read a fixed decoded MCP record.', effect: 'read', destination: 'local', labels: ['synthetic'],
    inputSchema: MCP_FIXTURE_DOCUMENTS_TOOL.inputSchema,
    outputSchema: { type: 'object', properties: { available: { type: 'boolean' } }, required: ['available'], additionalProperties: false } },
    remote: structuredClone(MCP_FIXTURE_DOCUMENTS_TOOL), projectorId: 'workflow-window', projectorVersion: '1',
    project(value) {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
      assert.equal(value['complete'], true);
      return { output: { available: true }, coverage: 'complete', observations: [{ sourceId: 'doc-origin', lineageId: 'doc-origin',
        locator: '/structuredContent/complete', observedAt: 900, coverage: 'complete', facts: { available: true } }] };
    } };
  const connection: McpSession = { endpointId: 'window-stored-result', generation: 1,
    protocolVersion: MCP_FIXTURE_PROTOCOL, discoveryDigest: 'd'.repeat(64) };
  // This seam substitutes only the decoded transport. Raw envelope publication,
  // custody, restoration, SQLite session originals and compact are actual services.
  // Process termination and real stdio are covered by the separate recovery suite.
  const client: Pick<McpStdioClient, 'discover' | 'call'> = {
    async discover() { assert.fail('the fixed decoded fixture must not discover'); },
    async call(session, name, input, context) {
      await context.authorize(); assert.equal(name, 'documents.read'); assert.equal(input['id'], 'good'); calls++;
      return { session, transportCalls: 1, value: { content: [{ type: 'text', text: 'fixed original' }],
        structuredContent: { ...fixtureRecord('documents.read', 'good') } } };
    },
  };
  const tool = createMcpReadTool(binding, connection, client, base, schemas);
  const open = (maxContextEntries: number, owner: string) => composeRuntime({
    services: { ...base, tools: [tool] }, schemas, owner, leaseMs: 1000, enablePlanning: false,
    guidanceSource: { list: async () => [], read: async () => { throw new Error('unexpected_guidance'); } },
    session: { repository: f.repository, agentId: 'window-agent', compact: { maxContextEntries, keepRecentEntries: 1 } },
  });
  const original = await open(8, 'original-window-owner');
  const before = await f.current();
  assert.ok(await original.sessions!.context(before));
  await original.runtime.submitPlan(f.workId, 'stored-window-plan', { baseStateRevision: before.revision,
    baseGoalRevision: before.goal.revision, basePlanRevision: 0, reason: 'Read one original before reconnect.', hypotheses: [], tasks: [{
      id: 'read-original', description: 'Read the fixed source', toolId: tool.definition.id, toolVersion: tool.definition.version,
      input: { id: 'good' }, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: ['criterion'],
    }] });
  const attempt = await original.runtime.reserve(f.workId, 'read-original');
  await original.runtime.dispatch(f.workId, attempt.id);
  // Stop at the real adapter response receipt, before the executor's receive.
  await new ToolBroker(base.state, original.contracts, base.digester, clock)
    .invoke(f.workId, attempt.id, original.runtime.owner, new AbortController().signal);
  const response = await base.state.receipt(f.workId, `mcp-response:${attempt.id}`); assert.ok(response);
  const raw = response.state.artifacts.at(-1)!;
  const rawBytes = await base.artifacts.get(raw, before.policy);
  const sourceInputs = await Promise.all(Array.from({ length: 5 }, (_, n) => f.repository.input(f.session.scope, `source-${n}`)));
  assert.equal(await base.state.receipt(f.workId, `receive:${attempt.id}`), null);
  clock.advance(attempt.leaseUntil - clock.now());

  // A host may reconnect with a smaller configured window without changing the
  // accepted input. Later messages from other work are not included in this basis.
  const reopened = await open(3, 'reconnected-window-owner');
  await assert.rejects(reopened.sessions!.context(await f.current()), /session_context_capacity/);
  await assert.rejects(reopened.recovery.restore(f.workId, windowActor), /session_context_capacity/);
  assert.equal(await reopened.compactPlanning!.compactStep(f.workId), null);
  const observed: { status: string; adopted: boolean; modelCalls: number }[] = [];
  const run = await reopened.workflow.run(f.workId, windowActor, { maxSteps: 30, onStep: async () => {
    const state = await f.current(); observed.push({ status: state.attempts[0]!.status,
      adopted: state.attempts[0]!.adopted, modelCalls: state.modelCalls.length });
  } });
  const done = await f.current();
  assert.equal(run.control.kind, 'complete'); assert.equal(done.status, 'completed');
  assert.equal(observed.length, run.steps);
  assert.deepEqual(observed.slice(0, 2), [
    { status: 'received', adopted: false, modelCalls: 0 }, { status: 'succeeded', adopted: true, modelCalls: 0 },
  ]);
  assert.ok(done.modelCalls.length >= 1);
  assert.ok(done.modelCalls.every(call => call.purpose === 'session_compact' && call.status === 'accepted'));
  assert.ok(f.planner.inputs.length >= 1, 'the actual compact provider must run before the checkpoint can fit');
  assert.ok(await reopened.sessions!.compactStatus(windowActor, f.session.scope.sessionId));
  assert.equal(calls, 1); assert.equal(done.attempts.length, 1); assert.equal(done.budget.used.toolCalls, 1);
  assert.equal(done.attempts[0]!.owner, attempt.owner); assert.equal(done.attempts[0]!.leaseUntil, attempt.leaseUntil);
  assert.equal(done.attempts[0]!.execution?.usage.transportCalls, 1);
  assert.equal(done.evidence[0]!.artifact?.id, raw.id);
  assert.deepEqual(await base.state.receipt(f.workId, `mcp-response:${attempt.id}`), response);
  assert.deepEqual(await base.artifacts.get(raw, done.policy), rawBytes);
  assert.deepEqual(await Promise.all(Array.from({ length: 5 }, (_, n) => f.repository.input(f.session.scope, `source-${n}`))), sourceInputs);
  const events = await base.state.events(f.workId, 0);
  assert.equal(events.filter(event => event.type === 'result_received').length, 1);
  assert.equal(events.filter(event => event.type === 'result_settled').length, 1);
  assert.ok(events.findIndex(event => event.type === 'result_settled') < events.findIndex(event => event.type === 'model_call_reserved'));
});

async function withoutCompact() {
  const f = await storedResultFixture();
  const runtime = new ExecutionRuntime(f.services, f.contracts, 'workflow-reconnected-owner', 1000);
  const workflow = new WorkflowRuntime(f.services, runtime, null, new ConversationService(f.services),
    new OutboxDispatcher(f.services, runtime.owner));
  f.clock.advance(f.attempt.leaseUntil - f.clock.now());
  return { f, runtime, workflow };
}

test('stored-result preflight respects the shared step limit even without a compact provider', async () => {
  const { f, workflow } = await withoutCompact(); let steps = 0;
  const first = await workflow.run(f.workId, windowActor, { maxSteps: 1, onStep: async () => { steps++; } });
  assert.deepEqual(first.control, { kind: 'yield', reason: 'step_limit' }); assert.equal(first.steps, 1); assert.equal(steps, 1);
  const received = await f.current();
  assert.equal(received.attempts[0]!.status, 'received'); assert.equal(received.evidence.length, 0);
  assert.equal(received.modelCalls.length, 0); assert.equal(f.controls.executeCalls, 0);
  const next = await workflow.run(f.workId, windowActor, { maxSteps: 5 });
  assert.equal(next.control.kind, 'complete'); assert.equal((await f.current()).attempts[0]!.adopted, true);
  assert.equal((await f.state.events(f.workId, 0)).filter(event => event.type === 'result_received').length, 1);
});

test('workflow preserves an explicit block on unreceived stored raw instead of reporting an expired recovery action', async () => {
  const { f, workflow } = await withoutCompact();
  await transact(f.services, f.workId, 'explicit-block', 'fixture_block', {}, state => {
    state.status = 'blocked'; state.statusReason = 'operator_review_required';
  });
  const before = await f.current(); let steps = 0;
  const run = await workflow.run(f.workId, windowActor, { maxSteps: 5, onStep: async () => { steps++; } });
  assert.deepEqual(run.control, { kind: 'blocked', reason: 'operator_review_required' });
  assert.equal(steps, 1); assert.equal(run.steps, 1);
  assert.deepEqual(await f.current(), before);
  assert.equal(f.controls.restoreCalls, 0); assert.equal(f.controls.executeCalls, 0);
  assert.equal(await f.state.receipt(f.workId, `receive:${f.attempt.id}`), null);
  assert.equal(await f.state.receipt(f.workId, `recover:${f.attempt.id}`), null);
});
