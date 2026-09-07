import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationService } from '../application/conversation-service.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { createExecutionAuthority } from '../application/execution-authority.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { ToolResultSchema } from '../application/contracts.js';
import { summarizeToolExecution } from '../application/tool-execution-usage.js';
import { transact } from '../application/work-transactions.js';
import type { RuntimeServices } from '../application/services.js';
import type { Tool } from '../application/ports.js';
import type { ToolResult, ToolUsage } from '../domain/model.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FakeClock, FakeSink, FixtureReadTool, ScriptedPlanner } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { scenario, request } from './session-flow-helpers.js';

const usage: ToolUsage = { transportCalls: 2, internalOperations: null, imageBytes: 512, waitMs: 4 };
const unknown: ToolUsage = { transportCalls: null, internalOperations: null, imageBytes: null, waitMs: null };
const zero: ToolUsage = { transportCalls: 0, internalOperations: 0, imageBytes: 0, waitMs: 0 };
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(t: TestContext, transform: (result: ToolResult) => unknown = value => value) {
  const entered = gate(), release = gate(), controller = new AbortController(), source = new FixtureReadTool(scenario.evidence);
  let returned: unknown; const running: Promise<void>[] = [];
  // Install the gated callback before ToolContracts captures it; mutate only the gate afterward.
  const tool: Tool = { definition: source.definition, async execute(task, context) {
    const result = await source.execute(task, context); result.usage = structuredClone(usage);
    returned = transform(result); entered.resolve(); await release.promise; return returned as ToolResult;
  } };
  const services: RuntimeServices = { state: new MemoryStateRepository(), artifacts: new MemoryArtifactStore(),
    clock: new FakeClock(1788566400000), ids: new RandomIds(), digester: new Sha256Digester(),
    planner: new ScriptedPlanner([]), sink: new FakeSink(), tools: [tool],
    executionAuthority: createExecutionAuthority({ actor: scenario.policy, scope: scenario.goal.scope, signal: controller.signal }) };
  const contracts = new ToolContracts([tool], new AjvSchemas()), runtime = new ExecutionRuntime(services, contracts, 'usage-authority');
  t.after(async () => {
    release.resolve();
    const outcomes = await Promise.allSettled(running);
    try {
      for (const id of runtime.pendingExecutions()) await runtime.settlePending(id);
      const failures = outcomes.flatMap(value => value.status === 'rejected' ? [value.reason] : []);
      if (failures.length) throw new AggregateError(failures, 'usage_fixture_execution_failed');
    } finally { await services.state.close(); }
  });
  const accepted = await new ConversationService(services).accept({ tenantId: scenario.policy.tenantId, principalId: scenario.policy.principalId }, request('usage-authority'));
  const workId = accepted.workId, initial = await runtime.state(workId);
  await runtime.submitPlan(workId, 'usage-plan', { baseStateRevision: initial.revision, baseGoalRevision: 1, basePlanRevision: 0,
    reason: 'Verify reported measurements independently from current source access', hypotheses: [], tasks: [{
      id: 'read', description: 'Read the declared original', toolId: 'fixture.read', toolVersion: '1',
      effect: 'read', input: { evidenceIds: ['doc-current'] }, dependsOn: [], maxAttempts: 1, satisfies: initial.goal.criteria.map(value => value.id),
    }] });
  const attempt = await runtime.reserve(workId, 'read');
  const narrow = () => transact(services, workId, 'narrow-labels', 'policy_changed', {}, state => { state.policy.allowedLabels = []; });
  return { services, runtime, source, controller, release, workId, attempt, narrow, returned: () => returned,
    async start() {
      const pending = runtime.execute(workId, attempt.id); running.push(pending);
      await Promise.race([entered.promise, pending.then(() => { throw new Error('usage_fixture_tool_not_entered'); })]);
    },
    async finish() { release.resolve(); await Promise.all(running); await runtime.settlePending(attempt.id); },
    state: () => runtime.state(workId),
    async stored() { const state = await runtime.state(workId); return ToolResultSchema.parse(JSON.parse(Buffer.from(
      await services.artifacts.get(state.attempts[0]!.resultArtifact!, state.policy)).toString())); },
  };
}

for (const boundary of ['before_receive', 'during_publication', 'abort'] as const)
  test(`late tool usage survives ${boundary} once while current authority cannot adopt the body`, { timeout: 10000 }, async t => {
    const f = await fixture(t); await f.start(); let intercepted = false;
    if (boundary === 'abort') f.controller.abort();
    else if (boundary === 'before_receive') await f.narrow();
    else {
      const put = f.services.artifacts.put.bind(f.services.artifacts);
      f.services.artifacts.put = async (...args) => {
        const ref = await put(...args); const body = JSON.parse(Buffer.from(args[0]).toString());
        if (!intercepted && body.attemptId === f.attempt.id && body.status === 'success') { intercepted = true; await f.narrow(); }
        return ref;
      };
    }
    await f.finish(); if (boundary === 'during_publication') assert.equal(intercepted, true);
    const before = await f.state(); assert.equal(f.source.invocations.length, 1);
    assert.deepEqual(before.attempts[0]!.execution?.usage, usage); assert.equal(before.budget.used.toolCalls, 1);
    assert.deepEqual(summarizeToolExecution(before).transportCalls, { measured: 2, unknown: 0 });
    assert.deepEqual(summarizeToolExecution(before).internalOperations, { measured: 0, unknown: 1 });
    const stored = await f.stored(); assert.deepEqual(stored.usage, usage);
    if (boundary !== 'abort') { assert.equal(stored.status, 'error'); assert.deepEqual(stored.evidence, []); assert.equal(stored.output, null); }
    await f.runtime.receive(f.workId, f.attempt.id, f.returned(), 'invoked');
    await f.runtime.receive(f.workId, f.attempt.id, f.returned(), 'invoked');
    await assert.rejects(f.runtime.receive(f.workId, f.attempt.id, { ...ToolResultSchema.parse(f.returned()),
      usage: { ...usage, transportCalls: 3 } }, 'invoked'), /result_identity_conflict/);
    assert.deepEqual(await f.state(), before);
    assert.equal((await f.services.state.events(f.workId, 0)).filter(value => value.type === 'result_received').length, 1);
    await f.runtime.adopt(f.workId, f.attempt.id);
    const denied = await f.state(); assert.deepEqual(denied.evidence, []); assert.equal(denied.attempts[0]!.adopted, false);
    assert.equal(denied.attempts[0]!.status, 'failed'); assert.deepEqual(denied.attempts[0]!.execution?.usage, usage);
    if (boundary === 'abort') {
      f.services.executionAuthority = createExecutionAuthority({ actor: scenario.policy, scope: scenario.goal.scope, signal: new AbortController().signal });
      await f.runtime.adopt(f.workId, f.attempt.id);
      assert.deepEqual(await f.state(), denied, 'a confirmed failed attempt is not reopened by a new authority');
    }
  });

test('a fresh valid lease may adopt a received read before rejection without charging its source again', { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.start(); f.controller.abort(); await f.finish();
  assert.equal((await f.state()).attempts[0]!.status, 'received');
  f.services.executionAuthority = createExecutionAuthority({ actor: scenario.policy, scope: scenario.goal.scope, signal: new AbortController().signal });
  await f.runtime.adopt(f.workId, f.attempt.id);
  const state = await f.state(); assert.equal(state.attempts[0]!.adopted, true); assert.equal(state.evidence.length, 1);
  assert.equal(f.source.invocations.length, 1); assert.equal(state.budget.used.toolCalls, 1); assert.deepEqual(state.attempts[0]!.execution?.usage, usage);
});

for (const invalid of ['usage', 'output', 'attempt', 'scope', 'reuse_claim'] as const)
  test(`label revocation does not trust a ${invalid} defect as reported source usage`, { timeout: 10000 }, async t => {
    const f = await fixture(t, result => {
      if (invalid === 'usage') return { ...result, usage: { ...usage, transportCalls: -1 } };
      if (invalid === 'output') return { ...result, output: null };
      if (invalid === 'attempt') return { ...result, attemptId: 'another-attempt' };
      if (invalid === 'scope') return { ...result, evidence: result.evidence.map(value => ({ ...value, scope: 'another-agent' })) };
      return { ...result, reuse: { attemptId: 'other', resultId: 'other-result', resultArtifact: {
        id: 'a'.repeat(64), sha256: 'a'.repeat(64), tenantId: scenario.policy.tenantId, labels: [], mediaType: 'application/json', byteLength: 1 },
      observedAt: 1788566400000, cacheKey: 'b'.repeat(64) } };
    });
    await f.start();
    if (invalid !== 'usage') assert.doesNotThrow(() => ToolResultSchema.parse(f.returned()), 'the defect is beyond the outer response schema');
    await f.narrow(); await f.finish(); await f.runtime.adopt(f.workId, f.attempt.id);
    const state = await f.state(); assert.equal(f.source.invocations.length, 1); assert.equal(state.attempts[0]!.adopted, false);
    assert.deepEqual(state.evidence, []); assert.deepEqual(state.attempts[0]!.execution?.usage, unknown);
    assert.equal((await f.stored()).usage, undefined);
  });

for (const mode of ['reused', 'not_invoked', 'unreported'] as const)
  test(`${mode} receipt does not turn historical usage into a measured invocation after label revocation`, async t => {
    const f = await fixture(t); assert.equal(await f.runtime.dispatch(f.workId, f.attempt.id), true);
    const raw = await new FixtureReadTool(scenario.evidence).execute({ id: 'read', description: 'Declared source', toolId: 'fixture.read', toolVersion: '1',
      effect: 'read', input: { evidenceIds: ['doc-current'] }, dependsOn: [], maxAttempts: 1, satisfies: [] },
    { workId: f.workId, attemptId: f.attempt.id, policy: scenario.policy, signal: new AbortController().signal });
    raw.usage = structuredClone(usage); await f.narrow();
    await f.runtime.receive(f.workId, f.attempt.id, raw, mode);
    const state = await f.state(); assert.equal(f.source.invocations.length, 0);
    assert.deepEqual(state.attempts[0]!.execution?.usage, mode === 'unreported' ? unknown : zero);
    assert.equal(state.attempts[0]!.execution?.implementationCalls, mode === 'unreported' ? null : 0);
    assert.equal((await f.stored()).usage, undefined);
  });
