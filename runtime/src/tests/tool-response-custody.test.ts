import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import type { StateRepository, Tool, ToolDefinition } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { BrokerError, ToolBroker } from '../application/tool-broker.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';
import { computerActor, computerActInput, computerHarness, computerResult, observeComputer, saveNoteSteps,
  submitComputerTask } from './computer-use-helpers.js';
import { advance, command, initial } from './state-conformance-helpers.js';

type Context = Parameters<Tool['execute']>[1];
type Variant = 'plain' | 'unproven' | 'collection' | 'reuse' | 'computer-input' | 'write';
const code = (expected: string) => (error: unknown) => error instanceof BrokerError && error.code === expected;
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

/** Real Broker + memory repository transactions and real reserve/dispatch; the tool performs no external I/O. */
async function fixture(t: TestContext, variant: Variant = 'plain') {
  const state = new MemoryStateRepository(), clock = new FakeClock(1000), digester = new Sha256Digester();
  t.after(() => state.close());
  const work = initial('response-custody-work'); work.policy.allowWrites = variant === 'write';
  const definition: ToolDefinition = { provider: 'fixture', id: 'fixture.read', version: '1', description: 'Response custody fixture',
    effect: variant === 'write' ? 'write' : 'read', destination: 'local', labels: ['synthetic'],
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, resultValidation: 'artifact-proof-v1' };
  if (variant === 'unproven') delete definition.resultValidation;
  if (variant === 'collection') definition.collection = { kind: 'batch', limits: { maxPages: 2, maxItems: 2, maxCalls: 2,
    maxPageBytes: 4096, maxCheckpointBytes: 65536, pageSize: 1 } };
  if (variant === 'reuse') definition.reuse = { mode: 'immutable', sourceVersion: 'fixture-v1' };
  if (variant === 'computer-input') definition.computerInputAssurance = 'synchronous-local-v1';
  let calls = 0;
  const controls: { execute?: (task: TaskSpec, context: Context) => Promise<ToolResult> } = {};
  const result = (attemptId: string): ToolResult => ({ resultId: `${attemptId}:result`, attemptId, status: 'success',
    effectState: 'none', output: {}, evidence: [], artifacts: [], coverage: 'complete', cursor: null, error: null });
  const tool: Tool = { definition, async validateResult() { return true; }, async execute(task, context) {
    calls++; return controls.execute ? controls.execute(task, context) : result(context.attemptId);
  } };
  const contracts = new ToolContracts([tool], new AjvSchemas());
  const services: RuntimeServices = { state, clock, digester, artifacts: new MemoryArtifactStore(), ids: new RandomIds(),
    planner: new ScriptedPlanner([]), sink: new FakeSink(), tools: [tool] };
  const runtime = new ExecutionRuntime(services, contracts, 'original-owner', 1000);
  assert.equal((await state.commit(command(work, 'accept'))).kind, 'committed');
  const task: TaskSpec = { id: 'read', toolId: definition.id, toolVersion: definition.version, description: 'Original task',
    input: { request: 'original' }, dependsOn: [], maxAttempts: 2, satisfies: ['criterion'], effect: definition.effect };
  await runtime.submitPlan(work.id, 'plan', { baseStateRevision: work.revision, baseGoalRevision: work.goal.revision,
    basePlanRevision: 0, reason: 'Response custody boundary', tasks: [task], hypotheses: [] });
  const attempt = await runtime.reserve(work.id, task.id); assert.equal(await runtime.dispatch(work.id, attempt.id), true);
  const broker = new ToolBroker(state, contracts, digester, clock), controller = new AbortController();
  const current = async () => { const value = await state.get(work.id); assert.ok(value); return value; };
  const edit = async (id: string, change: (value: WorkState) => void) => {
    const next = advance(await current()); change(next);
    assert.equal((await state.commit(command(next, id))).kind, 'committed');
  };
  const invoke = () => broker.invoke(work.id, attempt.id, runtime.owner, controller.signal);
  return { state, clock, digester, workId: work.id, runtime, contracts, broker, controller, controls, result, attempt, tool,
    current, edit, invoke, calls: () => calls };
}

test('plain proof read receives a read-only custody callback; current policy restrictions remain execution restrictions', async t => {
  for (const field of ['allowedLabels', 'allowedTools', 'allowedDestinations'] as const) {
    const f = await fixture(t); const before = await f.current();
    f.controls.execute = async (_task, context) => {
      assert.equal(typeof context.authorizeResponseCustody, 'function'); await context.authorize!();
      await f.edit(`narrow-${field}`, next => { next.policy[field] = []; });
      await assert.rejects(context.authorize!, code('broker_execution_not_current'));
      const narrowed = await f.current(), events = await f.state.events(f.workId, 0);
      await context.authorizeResponseCustody!(); await context.authorizeResponseCustody!();
      assert.deepEqual(await f.current(), narrowed); assert.deepEqual(await f.state.events(f.workId, 0), events);
      assert.deepEqual(context.policy, before.policy, 'original policy is not promoted into a new execution permit');
      return f.result(context.attemptId);
    };
    await f.invoke(); assert.equal(f.calls(), 1);
    assert.deepEqual((await f.current()).budget, before.budget, 'custody neither reserves nor settles');
    assert.deepEqual((await f.current()).artifacts, before.artifacts, 'the callback does not publish raw data');
  }
});

test('abort, elapsed lease/deadline and changed goal/plan do not erase an already entered original call', async t => {
  for (const change of ['abort', 'lease', 'deadline', 'goal-plan'] as const) {
    const f = await fixture(t);
    f.controls.execute = async (_task, context) => {
      await context.authorizeResponseCustody!();
      if (change === 'abort') f.controller.abort();
      if (change === 'lease') f.clock.advance(f.attempt.leaseUntil - f.clock.now());
      if (change === 'deadline') await f.edit('deadline', next => { next.deadlineAt = f.clock.now(); });
      if (change === 'goal-plan') await f.edit('new-goal', next => {
        next.goal.revision++; next.goal.description = 'Later goal'; next.goal.scope = 'later-scope'; next.plan = null;
      });
      await assert.rejects(context.authorize!, code('broker_execution_not_current'));
      await context.authorizeResponseCustody!(); return f.result(context.attemptId);
    };
    await f.invoke(); assert.equal(f.calls(), 1);
  }
});

test('terminal or explicitly blocked work preserves custody but does not grant execution authority', async t => {
  for (const status of ['cancelled', 'paused', 'failed', 'completed', 'blocked'] as const) {
    const f = await fixture(t);
    f.controls.execute = async (_task, context) => {
      await f.edit(`status-${status}`, next => { next.status = status; next.statusReason = 'explicit-control';
        if (status === 'cancelled') { next.attempts[0]!.status = 'cancelled'; next.attempts[0]!.finishedAt = f.clock.now(); }
      });
      await assert.rejects(context.authorize!, code('broker_execution_not_current'));
      await context.authorizeResponseCustody!(); assert.equal((await f.current()).status, status);
      return f.result(context.attemptId);
    };
    await f.invoke();
  }
});

test('original catalog entry can be removed or replaced after entry without changing old raw custody', async t => {
  for (const replacement of [false, true]) {
    const f = await fixture(t), saved = await f.state.receipt(f.workId, `dispatch:${f.attempt.id}`);
    f.controls.execute = async (_task, context) => {
      const definition = { ...f.tool.definition, description: 'Replacement', labels: ['restricted'] };
      f.contracts.replaceProvider('fixture', replacement ? [{ ...f.tool, definition }] : [],
        { expectedEpoch: f.contracts.providerEpoch('fixture'), sourceRevision: 'refreshed' });
      await assert.rejects(context.authorize!, code('tool_contract_changed'));
      await context.authorizeResponseCustody!();
      assert.deepEqual(await f.state.receipt(f.workId, `dispatch:${f.attempt.id}`), saved);
      return f.result(context.attemptId);
    };
    await f.invoke();
  }
});

test('stored-only transition blocks the next send while an entered original call retains its bounded custody permit', async t => {
  const f = await fixture(t), before = await f.current();
  const receipt = await f.state.receipt(f.workId, `dispatch:${f.attempt.id}`);
  let custody: (() => Promise<void>) | undefined;
  f.controls.execute = async (task, context) => {
    await context.authorize!(); custody = context.authorizeResponseCustody; assert.ok(custody);
    f.contracts.replaceProvider('fixture', [{ ...f.tool, availability: 'stored_only' }],
      { expectedEpoch: f.contracts.providerEpoch('fixture'), sourceRevision: 'stored-only' });
    assert.equal(f.contracts.check(task, before.policy), null);
    await assert.rejects(context.authorize!, code('tool_connection_required'));
    await custody(); await custody();
    return f.result(context.attemptId);
  };
  assert.equal((await f.invoke()).status, 'success'); assert.equal(f.calls(), 1);
  assert.ok(custody); await assert.rejects(custody, code('broker_response_custody_closed'));
  await assert.rejects(f.invoke(), code('tool_connection_required')); assert.equal(f.calls(), 1);
  assert.deepEqual(await f.current(), before);
  assert.deepEqual(await f.state.receipt(f.workId, `dispatch:${f.attempt.id}`), receipt);
});

test('non-plain definitions and a reused result do not receive a custody callback', async t => {
  for (const variant of ['unproven', 'collection', 'reuse', 'computer-input', 'write'] as const) {
    const f = await fixture(t, variant);
    f.controls.execute = async (_task, context) => {
      assert.equal(Object.hasOwn(context, 'authorizeResponseCustody'), false, variant);
      return f.result(context.attemptId);
    };
    await f.invoke(); assert.equal(f.calls(), 1);
  }

  // A verification tool requires an actual predecessor and reconciliation proof before Broker entry.
  const h = await computerHarness('sqlite', { continuations: true, leaseMs: 60000 }); t.after(() => h.close());
  assert.ok(h.driver instanceof SyntheticComputerDriver);
  const observed = await observeComputer(h);
  h.driver.injectNextAction({}); h.driver.injectNextAction({ outcome: 'applied_unknown' });
  const parent = await submitComputerTask(h, 'act', computerActInput(observed.observationId, saveNoteSteps));
  await h.runtime.execute(h.workId, parent.id); await h.runtime.settlePending(parent.id);
  assert.equal((await computerResult(h, parent.id)).effectState, 'unknown');
  await h.runtime.adopt(h.workId, parent.id);
  const source = (await h.runtime.state(h.workId)).attempts.find(value => value.id === parent.id)!;
  assert.ok(source.computerUse);
  const resume = { attemptId: source.id, checkpointId: source.computerUse.head.id };
  const reconciliation = await h.computerReconciliations.reconcile(h.workId, 'custody-test-reconcile', computerActor, resume);
  assert.equal(reconciliation.status, 'settled'); assert.ok(reconciliation.proofArtifact);
  const state = await h.runtime.state(h.workId);
  const task: TaskSpec = { id: 'custody-test-verify', toolId: 'synthetic.ui.verify', toolVersion: '1', description: 'Verify the original saved input',
    input: {}, computerResume: { ...resume, reconciliation: { id: reconciliation.id, proofId: reconciliation.proofArtifact.id } },
    dependsOn: [], effect: 'read', maxAttempts: 1, satisfies: ['saved'] };
  await h.runtime.submitPlan(h.workId, 'custody-test-verify-plan', { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision,
    basePlanRevision: state.plan!.revision, reason: 'Verify the original computer result', tasks: [task], hypotheses: [] });
  const successor = await h.runtime.reserve(h.workId, task.id); assert.equal(await h.runtime.dispatch(h.workId, successor.id), true);
  const original = h.contracts.get(task.toolId, task.toolVersion)!.tool; let verificationCalls = 0;
  assert.equal(original.definition.computerContinuation, 'verify');
  const verificationContracts = new ToolContracts([{ ...original, async execute(task, context) {
    verificationCalls++; assert.equal(Object.hasOwn(context, 'authorizeResponseCustody'), false, 'computer');
    return original.execute(task, context);
  } }], new AjvSchemas());
  const broker = new ToolBroker(h.state, verificationContracts, h.services.digester, h.clock, undefined,
    h.services.effects, h.computerContinuations, h.services);
  const verified = await broker.invoke(h.workId, successor.id, h.runtime.owner, new AbortController().signal);
  assert.equal(verified.status, 'success'); assert.equal(verified.effectState, 'none'); assert.equal(verificationCalls, 1);

  const f = await fixture(t);
  const reused = f.result(f.attempt.id);
  assert.deepEqual(await f.broker.invoke(f.workId, f.attempt.id, f.runtime.owner, f.controller.signal, { reuse: async () => reused }), reused);
  assert.equal(f.calls(), 0);
});

test('custody rejects changed tenant/principal, removed attempt and immutable attempt identity without writing', async t => {
  const changes: [string, (state: WorkState) => void][] = [
    ['tenant', next => { next.policy.tenantId = 'another-tenant'; }],
    ['principal', next => { next.policy.principalId = 'another-principal'; }],
    ['removed', next => { next.attempts = []; }],
    ...(['owner', 'inputDigest', 'contractDigest', 'toolVersion', 'taskId', 'scope'] as const).map(field =>
      [field, (next: WorkState) => { next.attempts[0]![field] = field.endsWith('Digest') ? 'f'.repeat(64) : 'another'; }] as [string, (state: WorkState) => void]),
    ['lease-replaced', next => { next.attempts[0]!.leaseUntil++; }],
    ['start-replaced', next => { next.attempts[0]!.startedAt++; }],
    ['goal-replaced', next => { next.attempts[0]!.goalRevision++; }],
    ['plan-replaced', next => { next.attempts[0]!.planRevision++; }],
  ];
  for (const [label, change] of changes) {
    const f = await fixture(t);
    f.controls.execute = async (_task, context) => {
      await f.edit(label, change); const before = await f.current();
      await assert.rejects(context.authorizeResponseCustody!, code('broker_response_custody_invalid'));
      assert.deepEqual(await f.current(), before); return f.result(context.attemptId);
    };
    await f.invoke();
  }
});

test('data deletion generation invalidates custody even when tenant and dispatch still match', async t => {
  const f = await fixture(t);
  f.controls.execute = async (_task, context) => {
    await f.edit('delete-data', next => { next.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] }; });
    await assert.rejects(context.authorizeResponseCustody!, code('broker_response_custody_invalid'));
    return f.result(context.attemptId);
  };
  await f.invoke();
});

test('missing or altered dispatch is rejected at custody recheck and corrupt original dispatch prevents entry', async t => {
  for (const alteration of ['missing', 'digest', 'task', 'definition-pin'] as const) {
    const f = await fixture(t), receipt = f.state.receipt.bind(f.state); let alter = false;
    f.state.receipt = async (workId, commandId) => {
      const value = await receipt(workId, commandId);
      if (alter && commandId === `dispatch:${f.attempt.id}` && value) {
        if (alteration === 'missing') return null;
        if (alteration === 'digest') value.digest = '0'.repeat(64);
        if (alteration === 'task') value.state.plan!.tasks[0]!.description = 'Changed dispatch task';
        if (alteration === 'definition-pin') value.state.attempts[0]!.contractDigest = '0'.repeat(64);
      }
      return value;
    };
    f.controls.execute = async (_task, context) => {
      alter = true; await assert.rejects(context.authorizeResponseCustody!, code('broker_response_custody_invalid'));
      return f.result(context.attemptId);
    };
    await f.invoke();
  }
  const f = await fixture(t), receipt = f.state.receipt.bind(f.state);
  f.state.receipt = async (...args) => { const value = await receipt(...args); if (value) value.digest = '0'.repeat(64); return value; };
  await assert.rejects(f.invoke(), code('broker_response_custody_invalid')); assert.equal(f.calls(), 0);
});

test('custody remains bound to the original state port and closes after success or original failure', async t => {
  for (const fail of [false, true]) {
    const f = await fixture(t); let captured!: NonNullable<Context['authorizeResponseCustody']>;
    const originalError = new Error('original-adapter-error');
    const other = new MemoryStateRepository(); t.after(() => other.close());
    f.controls.execute = async (_task, context) => {
      captured = context.authorizeResponseCustody!;
      // Deliberate runtime property mutation: the issued callback must keep its original port.
      (f.broker as unknown as { state: StateRepository }).state = other;
      await captured();
      if (fail) throw originalError;
      return f.result(context.attemptId);
    };
    if (fail) await assert.rejects(f.invoke(), error => error === originalError); else await f.invoke();
    await assert.rejects(captured, code('broker_response_custody_closed'));
  }
});

test('custody already waiting on storage is revoked when the execute promise finishes', async t => {
  const f = await fixture(t), reached = gate(), release = gate(); let wait = false; let rejected!: Promise<void>;
  const receipt = f.state.receipt.bind(f.state);
  f.state.receipt = async (...args) => { const value = await receipt(...args); if (wait) { reached.resolve(); await release.promise; } return value; };
  f.controls.execute = async (_task, context) => {
    wait = true; rejected = assert.rejects(context.authorizeResponseCustody!(), code('broker_response_custody_closed'));
    await reached.promise; return f.result(context.attemptId);
  };
  await f.invoke(); release.resolve(); await rejected;
});

test('revocation while reading dispatch/current state is checked after the last await', async t => {
  const f = await fixture(t), get = f.state.get.bind(f.state); let deleting = false;
  f.state.get = async workId => {
    if (deleting) { deleting = false; await f.edit('delete-during-custody-read', next => {
      next.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] };
    }); }
    return get(workId);
  };
  f.controls.execute = async (_task, context) => {
    deleting = true; await assert.rejects(context.authorizeResponseCustody!, code('broker_response_custody_invalid'));
    return f.result(context.attemptId);
  };
  await f.invoke();
});
