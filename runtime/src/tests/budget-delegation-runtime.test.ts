import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ContextPacket, Goal, Limits, Policy, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import type { CommitRequest, ModelCallOptions, ModelReply, Planner, StateRepository, Tool } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { BUDGET_DIMENSIONS, grantExposure, totalExposure, type BudgetGrant, type BudgetParent, type BudgetVector } from '../domain/budget-delegation.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { PlanningRuntime } from '../application/planning-runtime.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { transact } from '../application/work-transactions.js';
import { newExecutionControl } from '../domain/execution-policy.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FakeClock, FakeSink } from '../infrastructure/fakes.js';
import { Sha256Digester, RandomIds } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { adapters, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';
import type { BudgetAuthority } from '../application/budget-authority.js';
import { BudgetRuntimeRouter } from '../application/budget-runtime-router.js';
import { assertBudgetAuthority } from '../application/budget-delegation.js';
import type { BudgetMandate } from '../domain/budget-delegation.js';
import { ContextRecovery } from '../application/context-recovery.js';

const parentId = 'budget-parent';
const actor = { tenantId: 'tenant-a', principalId: 'person-a' };
const vector = (value: Partial<BudgetVector> = {}): BudgetVector => ({ toolCalls: 0, modelCalls: 0, tokens: 0, replans: 0, ...value });
const limits = (value: Partial<Limits> = {}): Limits => ({ toolCalls: 4, modelCalls: 2, tokens: 500, replans: 4, wallTimeMs: 30000, ...value });
type BudgetWork = WorkState & { budgetParent?: BudgetParent | undefined; budgetGrants?: BudgetGrant[] | undefined };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function reply(packet: ContextPacket, inputTokens = 80, outputTokens = 20): ModelReply {
  return { status: 'ok', provider: 'budget-fixture', model: 'synthetic', inputTokens, outputTokens,
    proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
      reason: 'Use a local original after a budgeted model call', tasks: [task('model-read', true)], hypotheses: [] } };
}
function task(id: string, available = false, effect: 'read' | 'write' = 'read'): TaskSpec {
  return { id, description: 'Read a synthetic original', toolId: 'fixture.read', toolVersion: '1', effect,
    input: { available }, dependsOn: [], maxAttempts: 1, satisfies: [] };
}
class BudgetPlanner implements Planner {
  readonly identity = { provider: 'budget-fixture', model: 'synthetic', revision: '1' };
  readonly destination = 'local';
  readonly capabilities = { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000 };
  readonly invocations: { packet: ContextPacket; signal: AbortSignal }[] = [];
  constructor(readonly respond: (packet: ContextPacket) => Promise<ModelReply> = async packet => reply(packet)) {}
  estimateInput(packet: ContextPacket, options: ModelCallOptions) {
    return { tokens: 100, bytes: new TextEncoder().encode(JSON.stringify({ packet, options })).byteLength, method: 'synthetic_fixed_100_tokens' };
  }
  async propose(packet: ContextPacket, signal: AbortSignal) {
    this.invocations.push({ packet: structuredClone(packet), signal }); return this.respond(packet);
  }
}
type ChildInput = { id: string; goal: Goal; policy: Policy; limits: Limits };
type Hooks = { beforeCommit?: ((request: CommitRequest) => Promise<void>) | undefined; afterCommit?: ((request: CommitRequest) => Promise<void>) | undefined };
async function harness(adapter: Adapter, options: { parentLimits?: Partial<Limits>; planner?: BudgetPlanner; writeUnknown?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-budget-runtime-')); const clock = new FakeClock(1000); const hooks: Hooks = {};
  const planner = options.planner ?? new BudgetPlanner(); const sink = new FakeSink(); const entries: { workId: string; attemptId: string }[] = [];
  const effect = options.writeUnknown ? 'write' : 'read';
  const tool: Tool = { definition: { provider: 'fixture', id: 'fixture.read', version: '1', description: 'Local synthetic budget source', effect,
    inputSchema: { type: 'object', properties: { available: { type: 'boolean' } }, required: ['available'], additionalProperties: false },
    outputSchema: { type: 'object' }, destination: 'local', labels: ['synthetic'] },
    async execute(selected, context): Promise<ToolResult> {
      const available = selected.input['available'] === true;
      entries.push({ workId: context.workId, attemptId: context.attemptId });
      return { resultId: `${context.attemptId}:result`, attemptId: context.attemptId, status: options.writeUnknown ? 'error' : 'success',
        effectState: options.writeUnknown ? 'unknown' : 'none', error: options.writeUnknown ? { code: 'synthetic_write_unconfirmed', retryable: false } : null,
        output: { available }, cursor: null, coverage: options.writeUnknown ? 'unknown' : 'complete', artifacts: [],
        evidence: options.writeUnknown ? [] : [{ id: `${context.workId}:${context.attemptId}:original`, tenantId: actor.tenantId, scope: 'fixture',
          sourceId: `source:${context.workId}`, lineageId: `lineage:${context.workId}`, locator: `local:${context.workId}`, labels: ['synthetic'],
          observedAt: clock.now(), recordedAt: clock.now(), coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [],
          facts: { available }, artifact: null }],
        usage: { transportCalls: 1, internalOperations: 1, imageBytes: 0, waitMs: 0 } };
    } };
  let raw = openRepository(adapter, directory);
  const repository: StateRepository = {
    get: id => raw.get(id), receipt: (id, commandId) => raw.receipt(id, commandId), events: (id, after) => raw.events(id, after),
    deliveries: id => raw.deliveries(id), runnable: now => raw.runnable(now), close: () => raw.close(),
    eventPage: (...args) => raw.eventPage(...args), recentEventMetadata: (...args) => raw.recentEventMetadata(...args), conversationWorkPage: query => raw.conversationWorkPage(query),
    workIdsForConversation: (...args) => raw.workIdsForConversation(...args), async commit(request) {
      await hooks.beforeCommit?.(request); const result = await raw.commit(request);
      if (result.kind === 'committed') await hooks.afterCommit?.(request); return result;
    },
  };
  const services: RuntimeServices = { state: repository, artifacts: new FileArtifactStore(join(directory, 'artifacts')), clock, planner, sink,
    ids: new RandomIds(), digester: new Sha256Digester(), tools: [tool] };
  const contracts = new ToolContracts([tool], new AjvSchemas()); let owner = 0;
  const open = () => {
    const execution = new ExecutionRuntime(services, contracts, `budget-owner-${++owner}`, 10000);
    const planning = new PlanningRuntime(services, contracts, execution, execution.owner, { leaseMs: 10000, maxOutputTokens: 50 });
    return { execution, planning };
  };
  let core = open(); const parent = initial(parentId); parent.goal.mode = 'deep'; parent.executionControl = newExecutionControl('deep');
  parent.budget.limits = { toolCalls: 12, modelCalls: 8, tokens: 5000, replans: 20, wallTimeMs: 60000, ...options.parentLimits };
  parent.policy.allowWrites = effect === 'write'; parent.deadlineAt = parent.createdAt + parent.budget.limits.wallTimeMs;
  assert.equal((await raw.commit(command(parent, 'create-parent'))).kind, 'committed');
  const read = async (id = parentId) => await core.execution.state(id) as BudgetWork;
  const input = (id: string, selectedLimits: Partial<Limits> = {}): ChildInput => ({ id, goal: structuredClone(parent.goal), policy: structuredClone(parent.policy), limits: limits(selectedLimits) });
  const child = (id = 'child', selectedLimits: Partial<Limits> = {}, commandId = `delegate:${id}`) =>
    core.execution.budgets.createChild(parentId, commandId, actor, 1, input(id, selectedLimits)) as Promise<BudgetWork>;
  const plan = async (id: string, taskId = 'read', available = false) => {
    await core.execution.budgets.prepare(id);
    const current = await read(id); await core.execution.submitPlan(id, `plan:${taskId}`, { baseStateRevision: current.revision,
      baseGoalRevision: current.goal.revision, basePlanRevision: current.plan?.revision ?? 0, reason: `Synthetic ${taskId}`,
      tasks: [task(taskId, available, effect)], hypotheses: [] });
  };
  const execute = async (id: string, taskId = 'read', adopt = true) => {
    const attempt = await core.execution.reserve(id, taskId); await core.execution.execute(id, attempt.id); await core.execution.settlePending(attempt.id);
    if (adopt) await core.execution.adopt(id, attempt.id); return attempt;
  };
  const grantFor = async (childId = 'child') => { const child = await read(childId); return (await read()).budgetGrants!.find(value => value.id === child.budgetParent!.grantId)!; };
  return { clock, planner, sink, entries, hooks, repository, services, read, input, child, plan, execute, grantFor,
    get execution() { return core.execution; }, get planning() { return core.planning; },
    async reopen() { await raw.close(); raw = openRepository(adapter, directory); services.artifacts = new FileArtifactStore(join(directory, 'artifacts')); core = open(); },
    async close() { await raw.close(); await rm(directory, { recursive: true, force: true }); } };
}
type Harness = Awaited<ReturnType<typeof harness>>;
async function use(adapter: Adapter, options: Parameters<typeof harness>[1], run: (fixture: Harness) => Promise<void>) {
  const fixture = await harness(adapter, options); try { await run(fixture); } finally { await fixture.close(); }
}

function fundedRole(f: Harness) {
  const rules = new Map<string, ChildInput & { mandate: BudgetMandate }>();
  const permissions = { allocation: true, execution: true };
  const calls: { purpose: string; workId: string }[] = [];
  const authority: BudgetAuthority = { async current(binding, purpose) {
    calls.push({ purpose, workId: binding.child.workId });
    const rule = rules.get(binding.mandate.referenceId);
    return permissions[purpose] && !!rule && binding.parent.workId === parentId && binding.parent.tenantId === actor.tenantId &&
      binding.parent.principalId === actor.principalId && binding.parent.goalRevision === 1 &&
      JSON.stringify(binding.mandate) === JSON.stringify(rule.mandate) && binding.child.workId === rule.id &&
      binding.child.goalRevision === rule.goal.revision && binding.child.scope === rule.goal.scope &&
      JSON.stringify(binding.child.policy) === JSON.stringify(rule.policy) &&
      BUDGET_DIMENSIONS.every(d => binding.child.allocated[d] === rule.limits[d]);
  } };
  const router = new BudgetRuntimeRouter(f.repository);
  const childServices: RuntimeServices = { ...f.services, budgetAuthority: authority, budgetChildren: router };
  const effectsRead: string[] = []; const interrupts: string[] = [];
  childServices.effects = { async current(state) { effectsRead.push(`current:${state.id}`); return true; },
    async refresh(workId) { effectsRead.push(`refresh:${workId}`); return f.read(workId); } };
  const contracts = new ToolContracts(childServices.tools, new AjvSchemas());
  let sequence = 0;
  const open = () => {
    const execution = new ExecutionRuntime(childServices, contracts, `funded-role-${++sequence}`, 10000);
    return { execution, planning: new PlanningRuntime(childServices, contracts, execution, execution.owner, { leaseMs: 10000, maxOutputTokens: 50 }) };
  };
  let core = open();
  f.services.budgetAuthority = authority; f.services.budgetChildren = router;
  const remove = router.register({ tenantId: actor.tenantId, principalId: 'person-b' }, childServices, id => { interrupts.push(id); core.execution.interrupt(id); });
  const input = (id = 'funded-child', selectedLimits: Partial<Limits> = {}) => {
    const value = f.input(id, selectedLimits); value.policy.principalId = 'person-b'; value.policy.allowedLabels.push('role-private');
    value.goal.description = 'Private role task description';
    const result = { ...value, mandate: { provider: 'fixture-funding', referenceId: `request:${id}`, revision: 1, childGoalRevision: 1 } };
    rules.set(result.mandate.referenceId, structuredClone(result)); return result;
  };
  return { permissions, authority, router, childServices, calls, effectsRead, interrupts, remove, input,
    create: (value = input(), commandId = `fund:${value.id}`) => f.execution.budgets.createChild(parentId, commandId, actor, 1, value),
    get execution() { return core.execution; }, get planning() { return core.planning; },
    async reopen() { await f.reopen(); childServices.artifacts = f.services.artifacts; core = open(); },
    async plan(workId: string, taskId = 'role-read', available = true) {
      await core.execution.budgets.prepare(workId); const state = await f.read(workId);
      await core.execution.submitPlan(workId, `role-plan:${taskId}`, { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision,
        basePlanRevision: state.plan?.revision ?? 0, reason: 'Use own role source', tasks: [task(taskId, available, f.services.tools[0]!.definition.effect)], hypotheses: [] });
    },
    async execute(workId: string, taskId = 'role-read') {
      const attempt = await core.execution.reserve(workId, taskId); await core.execution.execute(workId, attempt.id);
      await core.execution.settlePending(attempt.id); await core.execution.adopt(workId, attempt.id); return attempt;
    } };
}

for (const adapter of adapters) {
  test(`budget runtime ${adapter}: child execution settles once across duplicate creation, reconciliation and reopen without copying evidence`, async () => {
    await use(adapter, {}, async f => {
      const child = await f.child(); assert.equal(child.budgetParent!.phase, 'active'); assert.equal(child.budgetParent!.parentWorkId, parentId);
      const first = await f.grantFor(); assert.deepEqual(grantExposure(first), vector({ toolCalls: 4, modelCalls: 2, tokens: 500, replans: 4 }));
      assert.ok((await f.read()).obligations.some(value => value.kind === 'budget_reconciliation' && value.status === 'pending'));
      const duplicate = await f.child(); assert.deepEqual(duplicate.budgetParent, child.budgetParent); assert.equal((await f.read()).budgetGrants!.length, 1);
      await f.reopen(); assert.deepEqual((await f.child()).budgetParent, child.budgetParent);
      await f.plan(child.id, 'original', true); await f.execute(child.id, 'original'); assert.equal((await f.execution.runUntilYield(child.id, 3)).kind, 'complete');
      const settled = await f.execution.budgets.reconcile(parentId, first.id, actor); assert.equal(settled.status, 'settled'); assert.equal(settled.accounted.toolCalls, 1);
      const once = totalExposure(await f.read()); assert.deepEqual(once, vector({ toolCalls: 1 }));
      await f.execution.budgets.reconcile(parentId, first.id, actor); await f.reopen(); await f.execution.budgets.reconcile(parentId, first.id, actor);
      assert.deepEqual(totalExposure(await f.read()), once); assert.equal(f.entries.length, 1); assert.equal(f.planner.invocations.length, 0);
      assert.equal((await f.read(child.id)).evidence.length, 1); assert.deepEqual((await f.read()).evidence, []); assert.deepEqual((await f.read()).artifacts, []);
      assert.notEqual((await f.execution.step(parentId)).kind, 'complete');
    });
  });

  test(`budget runtime ${adapter}: parent remaining calls execute while escrow prevents parent and sibling over-allocation`, async () => {
    await use(adapter, { parentLimits: { toolCalls: 3 } }, async f => {
      await f.child('child', { toolCalls: 2 }); await f.plan(parentId, 'parent-read'); await f.execute(parentId, 'parent-read');
      assert.equal(f.entries.filter(value => value.workId === parentId).length, 1); assert.equal(totalExposure(await f.read()).toolCalls, 3);
      await assert.rejects(f.child('sibling', { toolCalls: 1 })); assert.equal((await f.read()).budgetGrants!.length, 1);
      await f.plan(parentId, 'parent-extra'); await assert.rejects(f.execution.reserve(parentId, 'parent-extra'));
      assert.equal((await f.read()).budget.used.toolCalls, 1); assert.equal(f.entries.length, 1); assert.equal(f.planner.invocations.length, 0);
    });
  });

  test(`budget runtime ${adapter}: concurrent sibling grants cannot oversubscribe one parent's remaining budget`, async () => {
    await use(adapter, { parentLimits: { toolCalls: 5 } }, async f => {
      const results = await Promise.allSettled([f.child('left', { toolCalls: 3 }), f.child('right', { toolCalls: 3 })]);
      assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
      const parent = await f.read(); assert.equal(parent.budgetGrants!.length, 1); assert.equal(totalExposure(parent).toolCalls, 3);
      const loser = results[0]!.status === 'rejected' ? 'left' : 'right'; const pending = await f.read(loser); assert.equal(pending.budgetParent!.phase, 'pending');
      await assert.rejects(f.planning.reserve(loser)); assert.equal(f.entries.length, 0); assert.equal(f.planner.invocations.length, 0);
    });
  });

  test(`budget runtime ${adapter}: a child's last logical tool call is consumed by an actual dispatch and cannot be minted by a new task ID`, async () => {
    await use(adapter, {}, async f => {
      await f.child('child', { toolCalls: 1 }); await f.plan('child', 'one'); const attempt = await f.execute('child', 'one');
      assert.ok(await f.repository.receipt('child', `dispatch:${attempt.id}`)); assert.equal((await f.read('child')).budget.used.toolCalls, 1);
      await f.plan('child', 'renamed'); await assert.rejects(f.execution.reserve('child', 'renamed'));
      await f.reopen(); await assert.rejects(f.execution.reserve('child', 'renamed'));
      assert.equal(f.entries.length, 1); assert.equal((await f.read('child')).budget.reservedToolCalls, 0);
    });
  });

  test(`budget runtime ${adapter}: actual model dispatch and reported tokens remain charged when its plan is rejected`, async () => {
    const planner = new BudgetPlanner(async () => ({ status: 'error', code: 'synthetic_failure', inputTokens: 80, outputTokens: 20 }));
    await use(adapter, { planner }, async f => {
      await f.child('child', { modelCalls: 1, tokens: 300 }); const call = await f.planning.reserve('child'); assert.equal(call.tokenReservation, 150);
      await f.planning.execute('child', call.id); assert.equal(await f.planning.adopt('child', call.id), false);
      const current = await f.read('child'); assert.equal(current.budget.used.modelCalls, 1); assert.equal(current.budget.used.tokens, 100);
      assert.equal(current.budget.reservedTokens, 0); assert.equal(current.budget.reservedModelCalls, 0); assert.ok(await f.repository.receipt('child', `model-dispatch:${call.id}`));
      f.clock.advance(100); await f.reopen(); await assert.rejects(f.planning.reserve('child'));
      assert.equal(f.planner.invocations.length, 1); assert.equal(f.entries.length, 0);
    });
  });

  test(`budget runtime ${adapter}: a child token cap below the estimated reservation prevents durable model allocation and transport`, async () => {
    await use(adapter, {}, async f => {
      await f.child('child', { tokens: 149 }); await assert.rejects(f.planning.reserve('child'));
      const current = await f.read('child'); assert.equal(current.modelCalls.length, 0); assert.equal(current.budget.reservedTokens, 0);
      assert.equal(current.budget.used.modelCalls, 0); assert.equal(f.planner.invocations.length, 0); assert.equal(f.entries.length, 0);
      assert.equal(grantExposure(await f.grantFor()).tokens, 149);
    });
  });

  for (const kind of ['tool', 'model'] as const) test(`budget runtime ${adapter}: revoking an unsent ${kind} reservation fences the child and returns only unused escrow`, async () => {
    await use(adapter, {}, async f => {
      const child = await f.child();
      if (kind === 'tool') { await f.plan(child.id); await f.execution.reserve(child.id, 'read'); }
      else await f.planning.reserve(child.id);
      const before = await f.read(child.id); await f.execution.budgets.revoke(parentId, child.budgetParent!.grantId, `revoke:${kind}`, actor, 1);
      const settled = await f.execution.budgets.reconcile(parentId, child.budgetParent!.grantId, actor); assert.equal(settled.status, 'settled');
      const current = await f.read(child.id); assert.equal(current.budgetParent!.phase, 'draining');
      assert.equal(current.budget.reservedToolCalls, 0); assert.equal(current.budget.reservedModelCalls, 0); assert.equal(current.budget.reservedTokens, 0);
      assert.equal(current.deadlineAt, before.deadlineAt); assert.deepEqual(totalExposure(await f.read()), vector());
      await assert.rejects(f.planning.reserve(child.id)); if (kind === 'tool') await assert.rejects(f.execution.reserve(child.id, 'read'));
      await f.reopen(); await assert.rejects(f.planning.reserve(child.id)); assert.equal(f.entries.length, 0); assert.equal(f.planner.invocations.length, 0);
    });
  });

  test(`budget runtime ${adapter}: revoke retains an active model's unknown usage, then late accounting settles once without adopting its plan`, { timeout: 15000 }, async () => {
    const entered = deferred<void>(); const response = deferred<ModelReply>();
    const planner = new BudgetPlanner(async () => { entered.resolve(); return response.promise; });
    await use(adapter, { planner }, async f => {
      const child = await f.child(); const call = await f.planning.reserve(child.id); const running = f.planning.execute(child.id, call.id); await entered.promise;
      try {
        await f.execution.budgets.revoke(parentId, child.budgetParent!.grantId, 'revoke-active-model', actor, 1); await running;
        const uncertain = await f.execution.budgets.reconcile(parentId, child.budgetParent!.grantId, actor);
        assert.notEqual(uncertain.status, 'settled'); assert.equal(uncertain.unmeasuredModelCalls, 1); assert.equal(uncertain.reserved.tokens, call.tokenReservation);
        assert.equal(grantExposure(uncertain).tokens, child.budget.limits.tokens); assert.equal(planner.invocations[0]!.signal.aborted, true);
        assert.equal((await f.read(child.id)).budget.used.unmeasuredModelCalls, 1);
      } finally { response.resolve(reply(planner.invocations[0]!.packet)); }
      await running; assert.deepEqual(await f.planning.settlePending(), []); assert.equal(await f.planning.adopt(child.id, call.id), false);
      const settled = await f.execution.budgets.reconcile(parentId, child.budgetParent!.grantId, actor); assert.equal(settled.status, 'settled');
      assert.equal(settled.accounted.modelCalls, 1); assert.equal(settled.accounted.tokens, 100); assert.equal(settled.reserved.tokens, 0); assert.equal(settled.unmeasuredModelCalls, 0);
      await f.planning.receive(child.id, call.id, reply(planner.invocations[0]!.packet)); await f.execution.budgets.reconcile(parentId, settled.id, actor);
      await f.reopen(); assert.equal(totalExposure(await f.read()).tokens, 100); assert.equal(f.planner.invocations.length, 1); assert.equal(f.entries.length, 0);
      assert.equal((await f.read(child.id)).plan, null);
    });
  });

  test(`budget runtime ${adapter}: unknown write effects keep the grant outstanding after revoke and restart`, async () => {
    await use(adapter, { writeUnknown: true }, async f => {
      const child = await f.child(); await f.plan(child.id, 'write'); await f.execute(child.id, 'write');
      await f.execution.budgets.revoke(parentId, child.budgetParent!.grantId, 'revoke-write', actor, 1);
      const retained = await f.execution.budgets.reconcile(parentId, child.budgetParent!.grantId, actor); assert.notEqual(retained.status, 'settled');
      assert.deepEqual(grantExposure(retained), retained.allocated); await f.reopen();
      const again = await f.execution.budgets.reconcile(parentId, retained.id, actor); assert.notEqual(again.status, 'settled');
      assert.ok((await f.read(child.id)).obligations.some(value => value.kind === 'effect_reconciliation' && value.status === 'pending'));
      assert.ok((await f.read()).obligations.some(value => value.kind === 'budget_reconciliation' && value.status === 'pending'));
      assert.notEqual((await f.execution.step(parentId)).kind, 'complete'); assert.equal(f.entries.length, 1); assert.equal(f.planner.invocations.length, 0);
    });
  });

  test(`budget runtime ${adapter}: reported model overage is charged to the parent without clamping and prevents further funding`, async () => {
    const planner = new BudgetPlanner(async () => ({ status: 'error', code: 'synthetic_overage', inputTokens: 400, outputTokens: 50 }));
    await use(adapter, { planner, parentLimits: { tokens: 400 } }, async f => {
      const child = await f.child('child', { tokens: 300 }); const call = await f.planning.reserve(child.id); await f.planning.execute(child.id, call.id);
      await f.planning.adopt(child.id, call.id); assert.equal((await f.read(child.id)).budget.used.tokens, 450);
      await f.execution.budgets.revoke(parentId, child.budgetParent!.grantId, 'revoke-overage', actor, 1);
      const settled = await f.execution.budgets.reconcile(parentId, child.budgetParent!.grantId, actor); assert.equal(settled.accounted.tokens, 450);
      assert.equal(totalExposure(await f.read()).tokens, 450); await assert.rejects(f.child('another', { tokens: 1 }));
      await f.reopen(); assert.equal(totalExposure(await f.read()).tokens, 450); assert.equal(f.planner.invocations.length, 1);
    });
  });

  test(`budget runtime ${adapter}: reducing limits preserves committed charges and child deadlines while blocking new grants`, async () => {
    await use(adapter, {}, async f => {
      const child = await f.child(); await f.plan(child.id, 'one'); await f.execute(child.id, 'one'); const before = await f.read(child.id);
      const parent = await f.read(); const reduced = { ...parent.budget.limits, toolCalls: 0, modelCalls: 0, tokens: 0, replans: 0 };
      await f.execution.budgets.reduceLimits(parentId, 'reduce-parent', actor, 1, reduced);
      await f.execution.budgets.reconcile(parentId, child.budgetParent!.grantId, actor);
      assert.equal((await f.read()).budget.limits.toolCalls, 0); assert.ok(totalExposure(await f.read()).toolCalls >= 1);
      assert.equal((await f.read(child.id)).budget.used.toolCalls, 1); assert.equal((await f.read(child.id)).deadlineAt, before.deadlineAt);
      await assert.rejects(f.child('new-child', { toolCalls: 1, modelCalls: 0, tokens: 0, replans: 0 }));
      await f.reopen(); assert.ok(totalExposure(await f.read()).toolCalls >= 1); assert.equal(f.entries.length, 1);
    });
  });

  for (const cancel of [false, true]) test(`budget runtime ${adapter}: pending genesis cannot execute before funding${cancel ? ' and parent cancellation wins activation' : ''}`, { timeout: 15000 }, async () => {
    await use(adapter, {}, async f => {
      const entered = deferred<void>(); const release = deferred<void>(); let held = false;
      f.hooks.beforeCommit = async request => {
        if (!held && request.workId === parentId && (request.next as BudgetWork).budgetGrants?.length) { held = true; entered.resolve(); await release.promise; }
      };
      const creation = f.child(); void creation.catch(() => undefined); await entered.promise;
      try {
        const pending = await f.read('child'); assert.equal(pending.budgetParent!.phase, 'pending');
        assert.equal((await f.read()).budgetGrants?.length ?? 0, 0); await assert.rejects(f.planning.reserve('child'));
        await assert.rejects(f.execution.reserve('child', 'read')); assert.equal(f.planner.invocations.length, 0); assert.equal(f.entries.length, 0);
        if (cancel) await f.execution.command(parentId, 'cancel-before-funding', actor, 1, { kind: 'cancel', reason: 'Cancel while child is unfunded' });
      } finally { release.resolve(); }
      if (cancel) { await assert.rejects(creation); assert.notEqual((await f.read('child')).budgetParent!.phase, 'active'); assert.equal((await f.read()).budgetGrants?.length ?? 0, 0); }
      else { assert.equal((await creation).budgetParent!.phase, 'active'); await f.plan('child'); await f.execute('child'); assert.equal(f.entries.length, 1); }
    });
  });

  test(`budget runtime ${adapter}: child funding rejects broader authority, altered duplicate commands and work ID reattachment`, async () => {
    await use(adapter, {}, async f => {
      const valid = f.input('child');
      for (const [index, policy] of [{ ...valid.policy, tenantId: 'foreign' }, { ...valid.policy, principalId: 'other-person' },
        { ...valid.policy, allowedLabels: ['restricted'] }, { ...valid.policy, allowedDestinations: ['remote'] }, { ...valid.policy, allowWrites: true }].entries())
        await assert.rejects(f.execution.budgets.createChild(parentId, `denied-${index}`, actor, 1, { ...valid, id: `denied-${index}`, policy }));
      assert.equal((await f.read()).budgetGrants?.length ?? 0, 0);
      const child = await f.child(); await assert.rejects(f.child('child', { toolCalls: 5 }));
      await assert.rejects(f.child('child', {}, 'different-parent-command'));
      assert.equal((await f.read()).budgetGrants!.length, 1); assert.equal((await f.read('child')).budgetParent!.grantId, child.budgetParent!.grantId);
      assert.equal(f.entries.length, 0); assert.equal(f.planner.invocations.length, 0);
    });
  });

  for (const stage of ['grant', 'activation'] as const) test(`budget runtime ${adapter}: ${stage} commit ACK loss resumes the same grant and child without another allocation`, async () => {
    await use(adapter, {}, async f => {
      let failed = false;
      f.hooks.afterCommit = async request => {
        const match = stage === 'grant' ? request.workId === parentId && request.events.some(value => value.type === 'budget_granted') :
          request.workId === 'child' && request.events.some(value => value.type === 'budget_child_activated');
        if (!failed && match) { failed = true; throw new Error('synthetic_ack_lost'); }
      };
      await assert.rejects(f.child(), /synthetic_ack_lost/); assert.equal(failed, true); await f.reopen();
      const child = await f.child(); assert.equal(child.budgetParent!.phase, 'active');
      assert.equal((await f.read()).budgetGrants!.length, 1); assert.equal((await f.repository.events(parentId, 0)).filter(value => value.type === 'budget_granted').length, 1);
      assert.equal((await f.repository.events(child.id, 0)).filter(value => value.type === 'budget_child_activated').length, 1);
      assert.deepEqual(totalExposure(await f.read()), vector({ toolCalls: 4, modelCalls: 2, tokens: 500, replans: 4 }));
      assert.equal(f.entries.length, 0); assert.equal(f.planner.invocations.length, 0);
    });
  });

  test(`budget runtime ${adapter}: revocation during child activation installs a fence that the stale activation cannot overwrite`, { timeout: 15000 }, async () => {
    await use(adapter, {}, async f => {
      const entered = deferred<void>(); const release = deferred<void>(); let held = false;
      f.hooks.beforeCommit = async request => {
        if (!held && request.workId === 'child' && request.events.some(value => value.type === 'budget_child_activated')) {
          held = true; entered.resolve(); await release.promise;
        }
      };
      const creation = f.child(); void creation.catch(() => undefined); await entered.promise;
      try {
        const pending = await f.read('child'); assert.equal(pending.budgetParent!.phase, 'pending');
        await f.execution.budgets.revoke(parentId, pending.budgetParent!.grantId, 'revoke-activating', actor, 1);
        assert.equal((await f.read('child')).budgetParent!.phase, 'draining');
      } finally { release.resolve(); }
      await assert.rejects(creation); assert.equal((await f.read('child')).budgetParent!.phase, 'draining');
      assert.equal((await f.grantFor()).status, 'settled'); assert.deepEqual(totalExposure(await f.read()), vector());
      await assert.rejects(f.planning.reserve('child')); assert.equal(f.entries.length, 0); assert.equal(f.planner.invocations.length, 0);
    });
  });

  for (const kind of ['tool', 'model'] as const) test(`budget runtime ${adapter}: revoke after ${kind} dispatch and before entry prevents transport while keeping the logical dispatch charge`, { timeout: 15000 }, async () => {
    await use(adapter, {}, async f => {
      const child = await f.child(); if (kind === 'tool') await f.plan(child.id);
      const call = kind === 'tool' ? await f.execution.reserve(child.id, 'read') : await f.planning.reserve(child.id);
      const entered = deferred<void>(); const release = deferred<void>(); let held = false;
      f.hooks.afterCommit = async request => {
        if (!held && request.workId === child.id && request.events.some(value => value.type === (kind === 'tool' ? 'attempt_dispatched' : 'model_call_dispatched'))) {
          held = true; entered.resolve(); await release.promise;
        }
      };
      const running = kind === 'tool' ? f.execution.execute(child.id, call.id) : f.planning.execute(child.id, call.id); void running.catch(() => undefined);
      await entered.promise;
      try { await f.execution.budgets.revoke(parentId, child.budgetParent!.grantId, `revoke-dispatched-${kind}`, actor, 1); }
      finally { release.resolve(); }
      await running;
      if (kind === 'tool') { await f.execution.settlePending(call.id); await f.execution.adopt(child.id, call.id); }
      else { await f.planning.settlePending(); await f.planning.adopt(child.id, call.id); }
      const current = await f.read(child.id); const settled = await f.execution.budgets.reconcile(parentId, child.budgetParent!.grantId, actor);
      assert.equal(current.budget.used[kind === 'tool' ? 'toolCalls' : 'modelCalls'], 1); assert.equal(current.budget.used.tokens, 0);
      assert.equal(settled.accounted[kind === 'tool' ? 'toolCalls' : 'modelCalls'], 1); assert.equal(settled.status, 'settled');
      assert.equal(f.entries.length, 0); assert.equal(f.planner.invocations.length, 0);
    });
  });

  test(`budget runtime ${adapter}: actual replan adoption spends the child's delegated replan allowance once`, async () => {
    await use(adapter, {}, async f => {
      await f.child('child', { replans: 1 }); await f.plan('child', 'first'); await f.execute('child', 'first');
      await f.plan('child', 'second'); await f.execute('child', 'second');
      assert.equal((await f.read('child')).budget.used.replans, 1); await assert.rejects(f.plan('child', 'third'));
      assert.equal((await f.read('child')).budget.used.replans, 1); assert.equal((await f.read('child')).plan!.tasks[0]!.id, 'second');
      const grant = await f.grantFor(); await f.execution.budgets.revoke(parentId, grant.id, 'revoke-after-replan', actor, 1);
      const settled = await f.execution.budgets.reconcile(parentId, grant.id, actor); assert.equal(settled.accounted.replans, 1);
      assert.equal(settled.accounted.toolCalls, 2); assert.equal(f.entries.length, 2); assert.equal(f.planner.invocations.length, 0);
    });
  });

  test(`budget runtime ${adapter}: nested child execution reconciles through both grants without double charging or copying originals`, async () => {
    await use(adapter, {}, async f => {
      const child = await f.child('child', { toolCalls: 6, modelCalls: 4, tokens: 2000, replans: 8 });
      const grandchild = await f.execution.budgets.createChild(child.id, 'delegate-grandchild', actor, 1, f.input('grandchild', { toolCalls: 2, modelCalls: 1, tokens: 300, replans: 2 }));
      await f.plan(grandchild.id, 'original', true); await f.execute(grandchild.id, 'original');
      assert.equal((await f.execution.runUntilYield(grandchild.id, 3)).kind, 'complete');
      const nested = await f.execution.budgets.reconcile(child.id, grandchild.budgetParent!.grantId, actor); assert.equal(nested.status, 'settled');
      assert.equal(nested.accounted.toolCalls, 1); await f.execution.budgets.revoke(parentId, child.budgetParent!.grantId, 'revoke-parent-child', actor, 1);
      const outer = await f.execution.budgets.reconcile(parentId, child.budgetParent!.grantId, actor); assert.equal(outer.status, 'settled'); assert.equal(outer.accounted.toolCalls, 1);
      assert.deepEqual(totalExposure(await f.read()), vector({ toolCalls: 1 })); assert.deepEqual(totalExposure(await f.read(child.id)), vector({ toolCalls: 1 }));
      assert.equal((await f.read(grandchild.id)).evidence.length, 1); assert.deepEqual((await f.read(child.id)).evidence, []); assert.deepEqual((await f.read()).evidence, []);
      await f.reopen(); await f.execution.budgets.reconcile(parentId, outer.id, actor); assert.equal(totalExposure(await f.read()).toolCalls, 1);
      assert.equal(f.entries.length, 1); assert.equal(f.planner.invocations.length, 0);
    });
  });

  test(`budget runtime ${adapter}: an unfunded pending child cannot turn resume or a new goal into execution authority`, async () => {
    await use(adapter, { parentLimits: { toolCalls: 0 } }, async f => {
      await assert.rejects(f.child('child', { toolCalls: 1 })); const pending = await f.read('child'); assert.equal(pending.budgetParent!.phase, 'pending');
      await Promise.allSettled([f.execution.command('child', 'resume-unfunded', actor, 1, { kind: 'resume', reason: 'Inspect pending child' })]);
      const current = await f.read('child');
      await Promise.allSettled([f.execution.command('child', 'change-unfunded-goal', actor, current.goal.revision,
        { kind: 'goal', expectedControlRevision: current.executionControl?.revision ?? 1, goal: { ...current.goal, revision: current.goal.revision + 1, description: 'Still unfunded' } })]);
      assert.equal((await f.read('child')).budgetParent!.phase, 'pending'); await assert.rejects(f.planning.reserve('child'), /budget_/);
      await assert.rejects(f.execution.reserve('child', 'read'), /budget_/); assert.equal((await f.read()).budgetGrants?.length ?? 0, 0);
      await f.reopen(); await assert.rejects(f.planning.reserve('child'), /budget_/); assert.equal(f.entries.length, 0); assert.equal(f.planner.invocations.length, 0);
    });
  });

  for (const boundary of ['goal', 'policy', 'deadline'] as const) test(`budget runtime ${adapter}: a parent ${boundary} change fences a child's previously reserved tool before entry`, async () => {
    await use(adapter, { parentLimits: { wallTimeMs: 20000 } }, async f => {
      const child = await f.child(); assert.ok(child.deadlineAt <= (await f.read()).deadlineAt); await f.plan(child.id); const attempt = await f.execution.reserve(child.id, 'read');
      if (boundary === 'goal') {
        const parent = await f.read(); await f.execution.command(parentId, 'parent-goal-change', actor, 1,
          { kind: 'goal', expectedControlRevision: parent.executionControl?.revision ?? 1, goal: { ...parent.goal, revision: 2, description: 'Changed parent goal' } });
      } else if (boundary === 'policy') await transact(f.services, parentId, 'parent-policy-change', 'policy_changed', {}, value => { value.policy.allowedLabels = []; });
      else f.clock.advance((await f.read()).deadlineAt - f.clock.now());
      await assert.rejects(f.execution.execute(child.id, attempt.id));
      const parent = await f.read(); const retained = await f.execution.budgets.reconcile(parentId, child.budgetParent!.grantId, actor);
      assert.notEqual(retained.status, 'active'); assert.equal((await f.read(child.id)).budgetParent!.phase, 'draining');
      assert.equal((await f.read(child.id)).budget.reservedToolCalls, 0); assert.equal((await f.read(child.id)).budget.used.toolCalls, 0);
      assert.equal(parent.evidence.length, 0); assert.equal(f.entries.length, 0); assert.equal(f.planner.invocations.length, 0);
    });
  });

  test(`budget runtime ${adapter}: a partially reported model response retains known tokens and unknown reservation after revoke and reopen`, async () => {
    const planner = new BudgetPlanner(async () => ({ status: 'error', code: 'synthetic_partial_usage', inputTokens: 25, outputTokens: null }));
    await use(adapter, { planner }, async f => {
      const child = await f.child(); const call = await f.planning.reserve(child.id); await f.planning.execute(child.id, call.id); await f.planning.adopt(child.id, call.id);
      await f.execution.budgets.revoke(parentId, child.budgetParent!.grantId, 'revoke-partial-usage', actor, 1);
      const pending = await f.execution.budgets.reconcile(parentId, child.budgetParent!.grantId, actor); assert.notEqual(pending.status, 'settled');
      assert.equal(pending.accounted.tokens, 25); assert.equal(pending.reserved.tokens, call.tokenReservation); assert.equal(pending.unmeasuredModelCalls, 1);
      await f.reopen(); const again = await f.execution.budgets.reconcile(parentId, pending.id, actor);
      assert.equal(again.accounted.tokens, 25); assert.equal(again.reserved.tokens, 150); assert.equal(again.unmeasuredModelCalls, 1);
      await assert.rejects(f.planning.reserve(child.id)); assert.equal(f.planner.invocations.length, 1); assert.equal(f.entries.length, 0);
    });
  });

  for (const kind of ['tool', 'model'] as const) test(`budget runtime ${adapter}: sibling overage received during a ${kind} dispatch ACK delay prevents its actual entry despite stale parent accounting`, { timeout: 15000 }, async () => {
    const firstEntered = deferred<void>(); const firstResponse = deferred<ModelReply>();
    const planner = new BudgetPlanner(async packet => {
      if (packet.workId === 'overage-child') { firstEntered.resolve(); return firstResponse.promise; }
      return reply(packet);
    });
    await use(adapter, { planner, parentLimits: { tokens: 500 } }, async f => {
      await f.child('overage-child', { tokens: 300 }); const second = await f.child('waiting-child', { tokens: 200 });
      const firstCall = await f.planning.reserve('overage-child'); const firstRunning = f.planning.execute('overage-child', firstCall.id); await firstEntered.promise;
      if (kind === 'tool') await f.plan(second.id);
      const secondCall = kind === 'tool' ? await f.execution.reserve(second.id, 'read') : await f.planning.reserve(second.id);
      const entered = deferred<void>(); const release = deferred<void>(); let held = false;
      f.hooks.afterCommit = async request => {
        if (!held && request.workId === second.id && request.events.some(value => value.type === (kind === 'tool' ? 'attempt_dispatched' : 'model_call_dispatched'))) {
          held = true; entered.resolve(); await release.promise;
        }
      };
      const secondRunning = kind === 'tool' ? f.execution.execute(second.id, secondCall.id) : f.planning.execute(second.id, secondCall.id);
      void secondRunning.catch(() => undefined); await entered.promise;
      try {
        firstResponse.resolve({ status: 'error', code: 'synthetic_sibling_overage', inputTokens: 600, outputTokens: 50 });
        await firstRunning; await f.planning.adopt('overage-child', firstCall.id);
        assert.equal((await f.read('overage-child')).budget.used.tokens, 650);
        assert.equal(totalExposure(await f.read()).tokens, 500, 'the test must reach the final gate with an older stored parent summary');
      } finally {
        firstResponse.resolve({ status: 'error', code: 'synthetic_cleanup', inputTokens: 600, outputTokens: 50 }); release.resolve();
      }
      await firstRunning; await secondRunning;
      if (kind === 'tool') { await f.execution.settlePending(secondCall.id); await f.execution.adopt(second.id, secondCall.id); }
      else { await f.planning.settlePending(); await f.planning.adopt(second.id, secondCall.id); }
      assert.equal(held, true); assert.equal(f.entries.length, 0); assert.equal(f.planner.invocations.length, 1);
      assert.equal((await f.read(second.id)).budget.used[kind === 'tool' ? 'toolCalls' : 'modelCalls'], 1);
      assert.equal((await f.read(second.id)).budget.used.tokens, 0);
    });
  });
}

for (const adapter of adapters) {
  test(`budget role ${adapter}: independently permitted role executes and returns unused resources without copying private data`, async () => {
    await use(adapter, {}, async f => {
      const role = fundedRole(f); const child = await role.create();
      assert.equal(child.policy.principalId, 'person-b'); assert.ok(child.policy.allowedLabels.includes('role-private'));
      f.services.effects = { current: async () => { throw new Error('wrong sponsor session'); }, refresh: async () => { throw new Error('wrong sponsor session'); } };
      await role.plan(child.id); await role.execute(child.id);
      assert.equal((await role.execution.runUntilYield(child.id, 3)).kind, 'complete');
      const grant = await f.execution.budgets.reconcile(parentId, child.budgetParent!.grantId, actor);
      assert.equal(grant.status, 'settled'); assert.equal(grant.accounted.toolCalls, 1);
      assert.equal(totalExposure(await f.read()).toolCalls, 1); assert.ok(role.effectsRead.includes(`refresh:${child.id}`));
      assert.ok(role.interrupts.includes(child.id)); assert.equal(f.entries.length, 1);
      assert.deepEqual((await f.read()).evidence, []); assert.deepEqual((await f.read()).artifacts, []);
      assert.equal(JSON.stringify(await f.read()).includes('Private role task description'), false);
      const childRef = (await f.read(child.id)).attempts[0]!.resultArtifact!;
      await assert.rejects(f.services.artifacts.get(childRef, (await f.read()).policy));
      await role.reopen(); await f.execution.budgets.reconcile(parentId, grant.id, actor);
      assert.equal(totalExposure(await f.read()).toolCalls, 1); assert.equal(f.planner.invocations.length, 0);
    });
  });

  test(`budget role ${adapter}: allocation permit prepares work but execution waits for the host execution permit`, async () => {
    await use(adapter, {}, async f => {
      const role = fundedRole(f); role.permissions.execution = false;
      const child = await role.create(); const grant = await f.grantFor(child.id);
      assert.equal(grant.status, 'active'); assert.equal(grantExposure(grant).toolCalls, child.budget.limits.toolCalls);
      await assert.rejects(role.plan(child.id), /budget_authority_denied/);
      await assert.rejects(role.planning.reserve(child.id), /budget_authority_denied/);
      assert.equal(f.entries.length, 0); assert.equal(f.planner.invocations.length, 0);
      role.permissions.execution = true; await role.plan(child.id); await role.execute(child.id);
      assert.equal(f.entries.length, 1);
    });
  });

  for (const missing of ['mandate', 'authority', 'router'] as const) test(`budget role ${adapter}: missing ${missing} cannot create a cross-role grant`, async () => {
    await use(adapter, {}, async f => {
      const role = fundedRole(f); const value: ChildInput & { mandate?: BudgetMandate } = role.input();
      if (missing === 'mandate') delete value.mandate;
      if (missing === 'authority') f.services.budgetAuthority = undefined;
      if (missing === 'router') f.services.budgetChildren = undefined;
      await assert.rejects(f.execution.budgets.createChild(parentId, 'missing-permit', actor, 1, value), /budget_policy_escalation|budget_authority_unavailable/);
      assert.equal(await f.repository.get(value.id), null); assert.equal((await f.read()).budgetGrants?.length ?? 0, 0);
    });
  });

  for (const change of ['tenant', 'principal', 'scope', 'policy', 'revision', 'limits'] as const) test(`budget role ${adapter}: changed ${change} cannot reuse an authority reference`, async () => {
    await use(adapter, {}, async f => {
      const role = fundedRole(f); const value = role.input();
      if (change === 'tenant') value.policy.tenantId = 'tenant-b';
      if (change === 'principal') value.policy.principalId = 'person-c';
      if (change === 'scope') value.goal.scope = 'another-scope';
      if (change === 'policy') value.policy.allowedLabels.push('unapproved-label');
      if (change === 'revision') value.mandate.revision++;
      if (change === 'limits') value.limits.toolCalls++;
      await assert.rejects(role.create(value), /budget_authority_denied|budget_mandate_binding_changed|budget_child_runtime_unavailable/);
      assert.equal(await f.repository.get(value.id), null); assert.equal((await f.read()).budgetGrants?.length ?? 0, 0);
    });
  });

  test(`budget role ${adapter}: one mandate cannot allocate twice through different child identities or command IDs`, async () => {
    await use(adapter, {}, async f => {
      const role = fundedRole(f); const firstInput = role.input(); const child = await role.create(firstInput);
      await role.create(firstInput); const second = role.input('second-child');
      const original = role.authority.current;
      role.authority.current = async (binding, purpose) => binding.child.workId === second.id ? true : original(binding, purpose);
      second.mandate = structuredClone(firstInput.mandate);
      await assert.rejects(role.create(second, 'another-command'), /budget_mandate_already_allocated/);
      assert.equal((await f.read()).budgetGrants!.length, 1); assert.equal((await f.read(second.id)).budgetParent!.phase, 'pending');
      assert.equal(totalExposure(await f.read()).toolCalls, child.budget.limits.toolCalls);
    });
  });

  for (const stage of ['genesis', 'grant', 'activation'] as const) test(`budget role ${adapter}: ${stage} reply loss resumes the original allocation after reopen`, async () => {
    await use(adapter, {}, async f => {
      const role = fundedRole(f); const value = role.input(); let lost = false;
      const event = stage === 'genesis' ? 'budget_child_pending' : stage === 'grant' ? 'budget_granted' : 'budget_child_activated';
      f.hooks.afterCommit = async request => { if (!lost && request.events.some(item => item.type === event)) { lost = true; throw new Error('role_reply_lost'); } };
      await assert.rejects(role.create(value), /role_reply_lost/); assert.equal(lost, true);
      await role.reopen(); const child = await role.create(value);
      assert.equal(child.budgetParent!.phase, 'active'); assert.equal((await f.read()).budgetGrants!.length, 1);
      await role.plan(child.id); await role.execute(child.id); assert.equal(f.entries.length, 1);
    });
  });

  for (const kind of ['tool', 'model'] as const) test(`budget role ${adapter}: authority withdrawal after ${kind} dispatch prevents actual entry`, async () => {
    await use(adapter, {}, async f => {
      const role = fundedRole(f); const child = await role.create();
      if (kind === 'tool') await role.plan(child.id);
      const call = kind === 'tool' ? await role.execution.reserve(child.id, 'role-read') : await role.planning.reserve(child.id);
      f.hooks.afterCommit = async request => {
        if (request.events.some(event => event.type === (kind === 'tool' ? 'attempt_dispatched' : 'model_call_dispatched'))) role.permissions.execution = false;
      };
      if (kind === 'tool') { await role.execution.execute(child.id, call.id); await role.execution.settlePending(call.id); }
      else { await role.planning.execute(child.id, call.id); await role.planning.settlePending(); }
      assert.equal(f.entries.length, 0); assert.equal(f.planner.invocations.length, 0);
      assert.equal((await f.read(child.id)).budget.used[kind === 'tool' ? 'toolCalls' : 'modelCalls'], 1);
    });
  });

  test(`budget role ${adapter}: parent change during permission lookup invalidates the child reservation`, async () => {
    await use(adapter, {}, async f => {
      const role = fundedRole(f); const child = await role.create(); await role.plan(child.id);
      const original = role.authority.current; let changed = false;
      role.authority.current = async (binding, purpose) => {
        const allowed = await original(binding, purpose);
        if (!changed && purpose === 'execution') {
          changed = true;
          await transact(f.services, parentId, 'parent-changed-during-authority', 'synthetic_parent_changed', {}, next => { next.goal.revision++; });
        }
        return allowed;
      };
      await assert.rejects(role.execution.reserve(child.id, 'role-read'), /budget_authority_state_changed|budget_authority_denied/);
      assert.equal(changed, true); assert.equal((await f.read(child.id)).budget.reservedToolCalls, 0); assert.equal(f.entries.length, 0);
    });
  });

  test(`budget role ${adapter}: missing child runtime retains escrow and recovery later refunds exactly once`, async () => {
    await use(adapter, {}, async f => {
      const role = fundedRole(f); const child = await role.create(); const id = child.budgetParent!.grantId;
      f.services.budgetChildren = undefined;
      await assert.rejects(f.execution.budgets.revoke(parentId, id, 'missing-route', actor, 1), /budget_child_runtime_unavailable/);
      assert.equal(grantExposure(await f.grantFor(child.id)).toolCalls, child.budget.limits.toolCalls);
      f.services.budgetChildren = role.router; await role.reopen();
      const settled = await f.execution.budgets.reconcile(parentId, id, actor);
      assert.equal(settled.status, 'settled'); assert.equal(totalExposure(await f.read()).toolCalls, 0);
      await f.execution.budgets.reconcile(parentId, id, actor); assert.equal(totalExposure(await f.read()).toolCalls, 0);
    });
  });

  test(`budget role ${adapter}: unknown write effect prevents refund after revocation and reopen`, async () => {
    await use(adapter, { writeUnknown: true }, async f => {
      const role = fundedRole(f); const child = await role.create(); await role.plan(child.id); await role.execute(child.id);
      role.permissions.allocation = false;
      const retained = await f.execution.budgets.reconcile(parentId, child.budgetParent!.grantId, actor);
      assert.equal(retained.status, 'draining'); assert.deepEqual(grantExposure(retained), retained.allocated);
      await role.reopen(); assert.equal((await f.execution.budgets.reconcile(parentId, retained.id, actor)).status, 'draining');
      assert.equal(f.entries.length, 1); assert.ok(role.interrupts.includes(child.id));
    });
  });

  test(`budget role ${adapter}: child runtime receives model cancellation and late usage settles without adopting a plan`, { timeout: 15000 }, async () => {
    const entered = deferred<void>(); const response = deferred<ModelReply>();
    const planner = new BudgetPlanner(async () => { entered.resolve(); return response.promise; });
    await use(adapter, { planner }, async f => {
      const role = fundedRole(f); const child = await role.create(); const call = await role.planning.reserve(child.id);
      const running = role.planning.execute(child.id, call.id); await entered.promise;
      try {
        await f.execution.budgets.revoke(parentId, child.budgetParent!.grantId, 'revoke-role-model', actor, 1); await running;
        const held = await f.execution.budgets.reconcile(parentId, child.budgetParent!.grantId, actor);
        assert.equal(held.status, 'draining'); assert.equal(held.unmeasuredModelCalls, 1);
        assert.equal(grantExposure(held).tokens, child.budget.limits.tokens); assert.equal(planner.invocations[0]!.signal.aborted, true);
      } finally { response.resolve(reply(planner.invocations[0]!.packet)); }
      await running; assert.deepEqual(await role.planning.settlePending(), []); assert.equal(await role.planning.adopt(child.id, call.id), false);
      const settled = await f.execution.budgets.reconcile(parentId, child.budgetParent!.grantId, actor);
      assert.equal(settled.status, 'settled'); assert.equal(settled.accounted.tokens, 100); assert.equal(settled.accounted.modelCalls, 1);
      await role.reopen(); await f.execution.budgets.reconcile(parentId, settled.id, actor);
      assert.equal(totalExposure(await f.read()).tokens, 100); assert.equal((await f.read(child.id)).plan, null);
    });
  });

  test(`budget role ${adapter}: child revision change during final proof lookup prevents settlement`, async () => {
    await use(adapter, {}, async f => {
      const role = fundedRole(f); const child = await role.create(); let changed = false;
      const original = role.router.effectsCurrent.bind(role.router);
      role.router.effectsCurrent = async (id, revision) => {
        const result = await original(id, revision);
        if (!changed) { changed = true; await transact(role.childServices, id, 'proof-read-race', 'synthetic_state_changed', {}, next => { next.statusReason = 'changed during proof read'; }); }
        return result;
      };
      await assert.rejects(f.execution.budgets.revoke(parentId, child.budgetParent!.grantId, 'race-refund', actor, 1), /budget_child_proof_changed/);
      assert.equal((await f.grantFor(child.id)).status, 'draining'); assert.equal(grantExposure(await f.grantFor(child.id)).toolCalls, child.budget.limits.toolCalls);
      assert.equal((await f.execution.budgets.reconcile(parentId, child.budgetParent!.grantId, actor)).status, 'settled');
    });
  });

  test(`budget role ${adapter}: removed route cannot validate old state or release funds`, async () => {
    await use(adapter, {}, async f => {
      const role = fundedRole(f); const child = await role.create();
      assert.equal(await role.router.effectsCurrent(child.id, child.revision), true); role.remove();
      assert.equal(await role.router.effectsCurrent(child.id, child.revision), false);
      await assert.rejects(f.execution.budgets.revoke(parentId, child.budgetParent!.grantId, 'removed-runtime', actor, 1), /budget_child_runtime_unavailable/);
      assert.equal((await f.grantFor(child.id)).status, 'draining');
    });
  });

  test(`budget role ${adapter}: changed child goal blocks further authority without changing recorded usage`, async () => {
    await use(adapter, {}, async f => {
      const role = fundedRole(f); const child = await role.create(); await role.plan(child.id); await role.execute(child.id);
      await transact(role.childServices, child.id, 'new-child-goal', 'synthetic_goal_change', {}, next => { next.goal.revision++; });
      await assert.rejects(assertBudgetAuthority(role.childServices, await f.read(child.id)), /budget_child_binding_changed/);
      await f.execution.budgets.reconcile(parentId, child.budgetParent!.grantId, actor);
      assert.equal(totalExposure(await f.read()).toolCalls, 1); assert.equal(f.entries.length, 1);
    });
  });
}

for (const adapter of adapters) {
  test(`budget role ${adapter}: nested ordinary children use their own role session when the sponsor settles the tree`, async () => {
    await use(adapter, {}, async f => {
      const role = fundedRole(f); const child = await role.create();
      f.services.effects = { current: async () => { throw new Error('wrong sponsor session'); }, refresh: async () => { throw new Error('wrong sponsor session'); } };
      const nested = await role.execution.budgets.createChild(child.id, 'nested-role-child', { tenantId: actor.tenantId, principalId: 'person-b' }, 1,
        { id: 'nested-child', goal: child.goal, policy: child.policy, limits: limits({ toolCalls: 2, modelCalls: 0, tokens: 0, replans: 1 }) });
      await role.plan(nested.id); await role.execute(nested.id);
      await f.execution.budgets.revoke(parentId, child.budgetParent!.grantId, 'nested-revoke', actor, 1);
      assert.equal((await f.grantFor(child.id)).status, 'settled'); assert.equal(totalExposure(await f.read()).toolCalls, 1);
      assert.ok(role.effectsRead.includes(`refresh:${nested.id}`)); assert.ok(role.interrupts.includes(nested.id));
      assert.deepEqual((await f.read()).evidence, []); assert.equal(f.entries[0]!.workId, nested.id);
    });
  });

  test(`budget role ${adapter}: context compact and restore preserve the stored funding authority and usage`, async () => {
    await use(adapter, {}, async f => {
      const role = fundedRole(f); const child = await role.create(); await role.plan(child.id); await role.execute(child.id);
      const prior = await f.read(child.id); const grant = await f.grantFor(child.id);
      const packed = await role.planning.context.prepare(prior, { callId: 'compact-funded', maxOutputTokens: 50,
        maxInputBytes: 1000000, maxInputTokens: 100000, forceCompact: true });
      assert.equal(packed.packet.execution!.delegation!.parentPhase, 'active');
      const recovery = new ContextRecovery(role.childServices, role.planning.tools);
      const resumed = await recovery.restore(child.id, prior.policy);
      assert.equal(resumed.packet.runtime.delegation!.parentPhase, 'active');
      await role.reopen(); assert.deepEqual((await f.grantFor(child.id)).mandate, grant.mandate);
      assert.equal((await f.read(child.id)).budget.used.toolCalls, 1);
      await assertBudgetAuthority(role.childServices, await f.read(child.id));
      await assert.rejects(recovery.restore(child.id, actor), /work_unavailable/);
      assert.equal(f.entries.length, 1); assert.equal(f.planner.invocations.length, 0);
    });
  });

  test(`budget role ${adapter}: route withdrawal inside authority lookup blocks a reserved tool before dispatch`, async () => {
    await use(adapter, {}, async f => {
      const role = fundedRole(f); const child = await role.create(); await role.plan(child.id);
      const original = role.authority.current;
      role.authority.current = async (binding, purpose) => { const allowed = await original(binding, purpose); role.remove(); return allowed; };
      await assert.rejects(role.execution.reserve(child.id, 'role-read'), /budget_child_runtime_unavailable/);
      assert.equal((await f.read(child.id)).budget.reservedToolCalls, 0); assert.equal(f.entries.length, 0);
    });
  });
}

for (const adapter of adapters) {
  test(`budget role ${adapter}: an authority lookup that ignores cancellation times out before adapter entry`, async () => {
    await use(adapter, {}, async f => {
      const role = fundedRole(f); const child = await role.create(role.input('short-deadline-child', { wallTimeMs: 50 }));
      await role.plan(child.id); let signal: AbortSignal | undefined;
      role.authority.current = async (_binding, _purpose, currentSignal) => { signal = currentSignal; return new Promise<boolean>(() => {}); };
      await assert.rejects(role.execution.reserve(child.id, 'role-read'), /budget_authority_timeout/);
      assert.equal(signal?.aborted, true); assert.equal(f.entries.length, 0); assert.equal((await f.read(child.id)).budget.reservedToolCalls, 0);
    });
  });

  test(`budget role ${adapter}: changing the authority adapter while it answers invalidates the old permit`, async () => {
    await use(adapter, {}, async f => {
      const role = fundedRole(f); const child = await role.create(); await role.plan(child.id);
      const original = role.authority.current;
      role.authority.current = async (binding, purpose) => {
        const allowed = await original(binding, purpose); role.childServices.budgetAuthority = { current: async () => false }; return allowed;
      };
      await assert.rejects(role.execution.reserve(child.id, 'role-read'), /budget_authority_changed/);
      assert.equal(f.entries.length, 0); assert.equal((await f.read(child.id)).budget.reservedToolCalls, 0);
    });
  });
}

for (const adapter of adapters) test(`budget role ${adapter}: temporary authority failure holds an active allocation and resumes without regranting`, async () => {
  await use(adapter, {}, async f => {
    const role = fundedRole(f); const child = await role.create(); const original = role.authority.current;
    role.authority.current = async () => { throw new Error('synthetic_authority_unavailable'); };
    await assert.rejects(f.execution.budgets.reconcile(parentId, child.budgetParent!.grantId, actor), /synthetic_authority_unavailable/);
    const held = await f.grantFor(child.id); assert.equal(held.status, 'active'); assert.deepEqual(grantExposure(held), held.allocated);
    await assert.rejects(role.plan(child.id), /synthetic_authority_unavailable/);
    assert.equal(f.entries.length, 0); await role.reopen(); role.authority.current = original;
    await role.plan(child.id); await role.execute(child.id); assert.equal(f.entries.length, 1);
    assert.equal((await f.read()).budgetGrants!.length, 1); assert.equal((await f.read(child.id)).budgetParent!.phase, 'active');
  });
});
