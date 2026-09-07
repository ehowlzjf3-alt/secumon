import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TaskSpec, WorkState } from '../domain/model.js';
import { newExecutionControl } from '../domain/execution-policy.js';
import type { ArtifactStore, CommitRequest, StateRepository, Tool } from '../application/ports.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { ToolBroker } from '../application/tool-broker.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { asJson, taskDigest, validatePlan } from '../application/plan-validator.js';
import { toolExecution } from '../application/tool-execution-usage.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner, SequenceIds } from '../infrastructure/fakes.js';
import { adapters, attempt, command, initial, openRepository, snapshot, type Adapter } from './state-conformance-helpers.js';

type Mode = 'continue' | 'verify';
type Stage = 'plan' | 'reserve' | 'dispatch' | 'broker';
const owner = 'continuation-unavailable-worker';

async function setup(t: TestContext, adapter: Adapter, mode: Mode, stage: Stage) {
  const directory = await mkdtemp(join(tmpdir(), 'computer-continuation-unavailable-'));
  const repository = openRepository(adapter, directory);
  t.after(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const counts = { commits: 0, puts: 0, execute: 0, validate: 0, brokerEntry: 0, reuse: 0 };
  const selected: Tool = { definition: { provider: 'fixture', id: `fixture.${mode}`, version: '1', description: 'Structurally valid but unsupported continuation',
    effect: mode === 'continue' ? 'write' : 'read', inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' },
    labels: ['synthetic'], destination: 'local', computerContinuation: mode, resultValidation: 'artifact-proof-v1' },
    async execute(_task, context) {
      counts.execute++;
      return { resultId: 'synthetic-result', attemptId: context.attemptId, status: 'success', effectState: mode === 'continue' ? 'confirmed' : 'none',
        evidence: [], artifacts: [], output: {}, error: null, cursor: null, coverage: 'complete' };
    },
    async validateResult() { counts.validate++; return true; } };
  const state = initial(`unavailable-${stage}-${mode}`); state.goal.mode = 'deep'; state.executionControl = newExecutionControl('deep');
  state.policy.allowedTools = [selected.definition.id]; state.policy.allowWrites = true;
  const spec: TaskSpec = { id: 'continuation-task', description: 'Resume only via a supported runner', dependsOn: [], toolId: selected.definition.id,
    toolVersion: '1', input: {}, effect: selected.definition.effect, maxAttempts: 1, satisfies: ['criterion'],
    computerResume: { attemptId: 'historical-parent', checkpointId: 'historical-head', reconciliation: null } };
  const digester = new Sha256Digester(); const contracts = new ToolContracts([selected], new AjvSchemas());
  assert.equal(contracts.check(spec, state.policy), null, 'the registry accepts the shape; runtime support is a separate decision');
  const proposal = { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision, basePlanRevision: 0,
    reason: 'Attempt explicit unsupported continuation', tasks: [spec], hypotheses: [] };
  assert.doesNotThrow(() => validatePlan(proposal, state, contracts, digester));
  if (stage !== 'plan') state.plan = { revision: 1, goalRevision: state.goal.revision, reason: 'Previously stored proposal', tasks: [spec] };
  if (stage === 'dispatch' || stage === 'broker') {
    const dispatched = stage === 'broker';
    state.attempts = [{ ...attempt(dispatched ? 'running' : 'reserved', 30000), owner, taskId: spec.id, toolId: spec.toolId, effect: spec.effect,
      inputDigest: taskDigest(spec, digester), contractDigest: digester.digest(asJson(selected.definition)),
      effectState: dispatched && mode === 'continue' ? 'unknown' : 'none', execution: toolExecution(dispatched ? 'unreported' : 'not_invoked') }];
    state.status = 'running'; state.budget.reservedToolCalls = dispatched ? 0 : 1; state.budget.used.toolCalls = dispatched ? 1 : 0;
  }
  assert.equal(Object.hasOwn(state, 'computerContinuations'), false, 'resume itself must be denied before a claim exists');
  const receiptId = stage === 'broker' ? 'dispatch:attempt' : 'seed';
  assert.equal((await repository.commit(command(state, receiptId))).kind, 'committed');
  const tracked = new Proxy(repository, { get(target, key) {
    if (key === 'commit') return async (request: CommitRequest) => { counts.commits++; return target.commit(request); };
    const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } }) as StateRepository;
  const backing = new MemoryArtifactStore();
  const artifacts: ArtifactStore = { get: backing.get.bind(backing), exists: backing.exists.bind(backing),
    async put(bytes, attributes) { counts.puts++; return backing.put(bytes, attributes); } };
  const planner = new ScriptedPlanner([]); const sink = new FakeSink();
  const services = { state: tracked, artifacts, planner, sink, tools: [selected], clock: new FakeClock(1000), ids: new SequenceIds(), digester };
  const runtime = new ExecutionRuntime(services, contracts, owner);
  const broker = new ToolBroker(tracked, contracts, digester, services.clock);
  const before = await snapshot(repository, state.id, [receiptId, 'blocked-plan', 'reserve:attempt-1', 'reserve:attempt-2', 'dispatch:attempt']);
  async function unchanged() {
    assert.deepEqual(await snapshot(repository, state.id, [receiptId, 'blocked-plan', 'reserve:attempt-1', 'reserve:attempt-2', 'dispatch:attempt']), before);
    assert.deepEqual(counts, { commits: 0, puts: 0, execute: 0, validate: 0, brokerEntry: 0, reuse: 0 });
    assert.equal(planner.inputs.length, 0); assert.equal(sink.delivered.size, 0);
    assert.deepEqual((await repository.get(state.id))!.budget, state.budget, 'a denied request cannot add a reservation or charge');
  }
  return { runtime, broker, counts, state, spec, proposal, unchanged };
}

for (const adapter of adapters) {
  test(`${adapter}: structurally valid continue and verify plans fail before acceptance or cost`, async t => {
    for (const mode of ['continue', 'verify'] as const) {
      const h = await setup(t, adapter, mode, 'plan');
      for (let retry = 0; retry < 2; retry++) await assert.rejects(h.runtime.submitPlan(h.state.id, 'blocked-plan', h.proposal), /computer_continuation_not_supported/);
      await h.unchanged();
    }
  });
  test(`${adapter}: a stored continuation plan cannot create a new attempt or budget reservation`, async t => {
    for (const mode of ['continue', 'verify'] as const) {
      const h = await setup(t, adapter, mode, 'reserve');
      for (let retry = 0; retry < 2; retry++) await assert.rejects(h.runtime.reserve(h.state.id, h.spec.id), /computer_continuation_not_supported/);
      await h.unchanged();
    }
  });
  test(`${adapter}: a stored continuation reservation cannot dispatch or enter through execute`, async t => {
    for (const mode of ['continue', 'verify'] as const) {
      const h = await setup(t, adapter, mode, 'dispatch');
      await assert.rejects(h.runtime.dispatch(h.state.id, 'attempt'), /computer_continuation_not_supported/);
      await assert.rejects(h.runtime.execute(h.state.id, 'attempt'), /computer_continuation_not_supported/);
      await h.unchanged();
    }
  });
  test(`${adapter}: even an existing dispatch receipt cannot invoke a continuation adapter or its reuse hook`, async t => {
    for (const mode of ['continue', 'verify'] as const) {
      const h = await setup(t, adapter, mode, 'broker');
      for (let retry = 0; retry < 2; retry++) await assert.rejects(h.broker.invoke(h.state.id, 'attempt', owner, new AbortController().signal, {
        entered: () => { h.counts.brokerEntry++; }, reuse: async (_state: WorkState) => { h.counts.reuse++; return null; },
      }), /computer_continuation_not_supported/);
      await h.unchanged();
    }
  });
}
