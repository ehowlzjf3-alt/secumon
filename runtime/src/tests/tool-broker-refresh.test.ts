import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeDependency } from '../domain/knowledge.js';
import type { TaskSpec, ToolResult } from '../domain/model.js';
import type { Tool, ToolDefinition } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { knowledgeInputsCurrent } from '../application/knowledge-validity.js';
import { BrokerError, ToolBroker } from '../application/tool-broker.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { adapters, advance, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, adapter: Adapter, options: { legacy?: boolean; knowledge?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'broker-refresh-'));
  const state = openRepository(adapter, directory);
  t.after(async () => { await state.close(); await rm(directory, { recursive: true, force: true }); });
  const source = initial('knowledge-source');
  source.evidence.push({ id: 'source-evidence', tenantId: source.policy.tenantId, scope: source.goal.scope, sourceId: 'synthetic-source',
    lineageId: 'synthetic-source', locator: 'fixture://synthetic-source', observedAt: 900, recordedAt: 1000,
    labels: ['synthetic'], coverage: 'complete', status: 'accepted', access: 'available', supersedes: [], derivedFrom: [],
    facts: { available: true }, artifact: null });
  assert.equal((await state.commit(command(source, 'accept-source'))).kind, 'committed');
  const dependency: KnowledgeDependency = { tenantId: 'tenant-a', knowledgeId: 'synthetic-memory', knowledgeRevision: 1,
    actorDigest: 'a'.repeat(64), parents: [], sources: [{ workId: source.id, evidenceId: 'source-evidence',
      sourceVersion: 'b'.repeat(64), generation: 0, workRevision: source.revision, policyDigest: 'c'.repeat(64) }] };
  let calls = 0;
  const result = (attemptId: string): ToolResult => ({ resultId: `${attemptId}:result`, attemptId, status: 'success', effectState: 'none',
    evidence: [], artifacts: [], output: { synthetic: true }, cursor: null, coverage: 'complete', error: null });
  const tool: Tool = { definition: { id: 'fixture.read', provider: 'fixture', version: '1', description: 'Synthetic broker boundary read',
    effect: 'read', destination: 'local', labels: ['synthetic'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    reuse: { mode: 'immutable', sourceVersion: 'fixture-v1' } },
  async execute(_task, context) { calls++; return result(context.attemptId); } };
  const services: RuntimeServices = { state, artifacts: new MemoryArtifactStore(), clock: new FakeClock(1000), ids: new RandomIds(),
    digester: new Sha256Digester(), planner: new ScriptedPlanner([]), sink: new FakeSink(), tools: [tool],
    ...(options.knowledge ? { knowledge: { validate: async (dependencies: KnowledgeDependency[]) => {
      assert.deepEqual(dependencies, [dependency]);
      return (await state.get(source.id))?.evidence[0]?.access === 'available';
    } } } : {}) };
  const contracts = new ToolContracts([tool], new AjvSchemas());
  const runtime = new ExecutionRuntime(services, contracts, 'broker-worker');
  const work = initial(); assert.equal((await state.commit(command(work, 'accept-consumer'))).kind, 'committed');
  const task: TaskSpec = { id: 'read', description: 'Read a synthetic source', toolId: 'fixture.read', toolVersion: '1', input: {},
    effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [] };
  await runtime.submitPlan(work.id, 'plan', { baseStateRevision: work.revision, baseGoalRevision: 1, basePlanRevision: 0,
    reason: 'Exercise the broker after a durable dispatch', tasks: [task], hypotheses: [] });
  const attempt = await runtime.reserve(work.id, task.id);
  if (options.legacy || options.knowledge) {
    const next = advance((await state.get(work.id))!); const saved = next.attempts.find(value => value.id === attempt.id)!;
    if (options.legacy) delete saved.contractDigest;
    if (options.knowledge) saved.knowledgeDependencies = [dependency];
    assert.equal((await state.commit(command(next, 'prepare-synthetic-attempt'))).kind, 'committed');
  }
  assert.equal(await runtime.dispatch(work.id, attempt.id), true);
  const receipt = await state.receipt(work.id, `dispatch:${attempt.id}`); assert.ok(receipt);
  assert.equal(receipt.state.attempts.find(value => value.id === attempt.id)!.status, 'running');
  if (options.legacy) assert.equal(receipt.state.attempts.find(value => value.id === attempt.id)!.contractDigest, undefined);
  const before = (await state.get(work.id))!;
  return { state, services, contracts, runtime, tool, task, attempt, workId: work.id, sourceId: source.id, before, calls: () => calls, result };
}

for (const adapter of adapters) {
  test(`${adapter}: broker rechecks source knowledge after a real reuse lookup misses`, { timeout: 10000 }, async t => {
    const f = await fixture(t, adapter, { knowledge: true }); const started = gate(); const resume = gate();
    let misses = 0; const checks: boolean[] = [];
    const broker = new ToolBroker(f.state, f.contracts, f.services.digester, f.services.clock, async state => {
      const current = await knowledgeInputsCurrent(f.services, state); checks.push(current); return current;
    });
    const invocation = broker.invoke(f.workId, f.attempt.id, f.runtime.owner, new AbortController().signal, {
      reuse: async (state, task, attempt) => {
        started.resolve(); await resume.promise;
        const candidate = await f.runtime.resultReuse.find(state, task, attempt);
        assert.equal(candidate, null); misses++; return candidate;
      },
    });
    const rejected = assert.rejects(invocation, error => error instanceof BrokerError && error.code === 'broker_knowledge_changed');
    await started.promise;
    const source = advance((await f.state.get(f.sourceId))!); source.evidence[0]!.access = 'deleted'; source.evidence[0]!.facts = {};
    assert.equal((await f.state.commit(command(source, 'delete-source-during-reuse'))).kind, 'committed');
    assert.deepEqual(await f.state.get(f.workId), f.before);
    resume.resolve(); await rejected;
    assert.equal(misses, 1); assert.equal(checks[0], true); assert.equal(checks.at(-1), false); assert.ok(checks.length >= 2);
    assert.equal(f.calls(), 0); assert.deepEqual(await f.state.get(f.workId), f.before);
  });

  for (const phase of ['beforeInvoke', 'reuse'] as const) for (const change of ['destination', 'labels', 'effect'] as const) {
    test(`${adapter}: legacy attempt rejects a ${change} replacement during ${phase}`, { timeout: 10000 }, async t => {
      const f = await fixture(t, adapter, { legacy: true }); const started = gate(); const resume = gate(); let intercepted = false; let replacementCalls = 0;
      const intercept = async () => { if (!intercepted) { intercepted = true; started.resolve(); await resume.promise; } };
      const broker = new ToolBroker(f.state, f.contracts, f.services.digester, f.services.clock, async () => {
        if (phase === 'beforeInvoke') await intercept(); return true;
      });
      const invocation = broker.invoke(f.workId, f.attempt.id, f.runtime.owner, new AbortController().signal, {
        reuse: async () => { if (phase === 'reuse') await intercept(); return null; },
      });
      const rejected = assert.rejects(invocation, error => error instanceof BrokerError &&
        ['tool_contract_changed', 'tool_permission_denied', 'tool_effect_mismatch'].includes(error.code));
      await started.promise;
      const definition: ToolDefinition = structuredClone(f.tool.definition);
      if (change === 'destination') definition.destination = 'not-authorized';
      if (change === 'labels') definition.labels = ['restricted'];
      if (change === 'effect') { definition.effect = 'write'; delete definition.reuse; }
      f.contracts.replaceProvider('fixture', [{ definition, async execute(_task, context) { replacementCalls++; return f.result(context.attemptId); } }],
        { expectedEpoch: f.contracts.providerEpoch('fixture'), sourceRevision: `changed-${change}` });
      resume.resolve(); await rejected;
      assert.equal(intercepted, true); assert.equal(f.calls(), 0); assert.equal(replacementCalls, 0);
      assert.deepEqual(await f.state.get(f.workId), f.before);
    });
  }

  test(`${adapter}: an unchanged legacy attempt invokes once after asynchronous guards and a reuse miss`, async t => {
    const f = await fixture(t, adapter, { legacy: true }); let entered = 0; let misses = 0; let checks = 0;
    const broker = new ToolBroker(f.state, f.contracts, f.services.digester, f.services.clock, async () => {
      await f.state.get(f.workId); checks++; return true;
    });
    const result = await broker.invoke(f.workId, f.attempt.id, f.runtime.owner, new AbortController().signal, {
      reuse: async () => { await f.state.receipt(f.workId, `dispatch:${f.attempt.id}`); misses++; return null; },
      entered: () => { entered++; }, reused: () => { assert.fail('legacy result must not be reused'); },
    });
    assert.equal(result.attemptId, f.attempt.id); assert.equal(result.status, 'success'); assert.equal(f.calls(), 1);
    assert.equal(entered, 1); assert.equal(misses, 1); assert.ok(checks >= 2);
    assert.deepEqual(await f.state.get(f.workId), f.before);
  });

  for (const phase of ['beforeInvoke', 'reuse'] as const)
    test(`${adapter}: stored-only replacement during ${phase} prevents entry without invalidating the saved dispatch contract`, { timeout: 10000 }, async t => {
      const f = await fixture(t, adapter); const started = gate(), resume = gate(); let intercepted = false, entered = 0, checks = 0;
      const intercept = async () => { if (!intercepted) { intercepted = true; started.resolve(); await resume.promise; } };
      const broker = new ToolBroker(f.state, f.contracts, f.services.digester, f.services.clock, async () => {
        checks++; if (phase === 'beforeInvoke') await intercept(); return true;
      });
      const receipt = await f.state.receipt(f.workId, `dispatch:${f.attempt.id}`);
      const invocation = broker.invoke(f.workId, f.attempt.id, f.runtime.owner, new AbortController().signal, {
        reuse: async () => { if (phase === 'reuse') await intercept(); return null; }, entered: () => { entered++; },
      });
      const rejected = assert.rejects(invocation, error => error instanceof BrokerError && error.code === 'tool_connection_required');
      try {
        await started.promise;
        f.contracts.replaceProvider('fixture', [{ ...f.tool, availability: 'stored_only' }],
          { expectedEpoch: f.contracts.providerEpoch('fixture'), sourceRevision: 'stored-only' });
      } finally { resume.resolve(); }
      await rejected;
      assert.equal(f.contracts.check(f.task, f.before.policy), null);
      assert.equal(f.contracts.checkExecution(f.task, f.before.policy), 'tool_connection_required');
      assert.equal(entered, 0); assert.equal(f.calls(), 0);
      const priorChecks = checks;
      await assert.rejects(broker.invoke(f.workId, f.attempt.id, f.runtime.owner, new AbortController().signal, {
        reuse: async () => { assert.fail('stored-only registration cannot begin a new lookup'); },
      }), error => error instanceof BrokerError && error.code === 'tool_connection_required');
      assert.equal(checks, priorChecks); assert.equal(f.calls(), 0);
      assert.deepEqual(await f.state.get(f.workId), f.before);
      assert.deepEqual(await f.state.receipt(f.workId, `dispatch:${f.attempt.id}`), receipt);
    });
}
