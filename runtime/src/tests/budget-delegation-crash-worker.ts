import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ContextPacket, PlanProposal, TaskSpec, ToolResult } from '../domain/model.js';
import type { CommitRequest, ModelCallOptions, Planner, StateRepository, Tool } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { assertBudgetAuthority } from '../application/budget-delegation.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { PlanningRuntime } from '../application/planning-runtime.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { newExecutionControl } from '../domain/execution-policy.js';
import { totalExposure } from '../domain/budget-delegation.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FakeClock, FakeSink } from '../infrastructure/fakes.js';
import { Sha256Digester, RandomIds } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { adapters, command, initial, openRepository } from './state-conformance-helpers.js';

const directory = process.argv[2]!;
const stage = process.argv[3]!;
const adapter = adapters.find(value => value === process.argv[4]);
const reservation = process.argv[5] === 'model' ? 'model' : 'tool';
if (!adapter) throw new Error('invalid_test_adapter');
const parentId = 'budget-crash-parent';
const childId = 'budget-crash-child';
const actor = { tenantId: 'tenant-a', principalId: 'person-a' };
const createCommand = 'crash-create';
const revokeCommand = 'crash-revoke';
const clock = new FakeClock(1000);
const raw = openRepository(adapter, directory);
const ledger = new DatabaseSync(join(directory, 'entries.sqlite'));
ledger.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS entries(sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, operation_id TEXT NOT NULL);');
const count = (kind: string) => Number(ledger.prepare('SELECT COUNT(*) AS n FROM entries WHERE kind=?').get(kind)!['n']);

function crash(): Promise<never> {
  return new Promise<never>(() => {
    process.send!({ type: 'checkpoint', stage, parentId, childId, toolEntries: count('tool'), modelEntries: count('model') },
      () => process.kill(process.pid, 'SIGKILL'));
  });
}
function selectedCut(request: CommitRequest): boolean {
  const events: Record<string, string> = {
    'child-genesis': 'budget_child_pending',
    'parent-grant': 'budget_granted',
    'child-activation': 'budget_child_activated',
    'parent-draining': 'budget_revoke_requested',
    'child-fence': 'budget_child_fenced',
  };
  if (stage === 'parent-settlement') return request.workId === parentId &&
    request.events.some(event => event.type === 'budget_usage_observed') && request.next.budgetGrants?.[0]?.status === 'settled';
  return request.events.some(event => event.type === events[stage]);
}
const repository: StateRepository = {
  get: id => raw.get(id), receipt: (id, commandId) => raw.receipt(id, commandId), events: (id, after) => raw.events(id, after),
  deliveries: id => raw.deliveries(id), runnable: now => raw.runnable(now), close: () => raw.close(),
  workIdsForConversation: (...args) => raw.workIdsForConversation(...args),
  recentEventMetadata: (...args) => raw.recentEventMetadata(...args), conversationWorkPage: query => raw.conversationWorkPage(query),
  async commit(request) {
    const result = await raw.commit(request);
    // The process dies after the selected backend's durable commit, before its caller observes success.
    if (result.kind === 'committed' && selectedCut(request)) return crash();
    return result;
  },
};
function task(id: string): TaskSpec {
  return { id, description: `Read synthetic ${id} record`, toolId: 'fixture.read', toolVersion: '1',
    effect: 'read', input: { marker: id }, dependsOn: [], maxAttempts: 1, satisfies: [] };
}
function proposal(packet: Pick<ContextPacket, 'stateRevision' | 'goal' | 'plan'>, id: string): PlanProposal {
  return { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
    reason: 'Synthetic crash-boundary plan', tasks: [task(id)], hypotheses: [] };
}
const tool: Tool = {
  definition: { provider: 'fixture', id: 'fixture.read', version: '1', description: 'Synthetic local crash fixture', effect: 'read',
    inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false },
    outputSchema: { type: 'object' }, destination: 'local', labels: ['synthetic'] },
  async execute(_task, context): Promise<ToolResult> {
    ledger.prepare('INSERT INTO entries(kind,operation_id) VALUES(?,?)').run('tool', context.attemptId);
    return { resultId: `${context.attemptId}:result`, attemptId: context.attemptId, status: 'success', effectState: 'none', error: null,
      output: { available: false }, cursor: null, coverage: 'complete', artifacts: [], evidence: [{
        id: 'synthetic-original', tenantId: actor.tenantId, scope: 'fixture', sourceId: 'synthetic-source', lineageId: 'synthetic-lineage',
        locator: 'local:synthetic-original', labels: ['synthetic'], observedAt: clock.now(), recordedAt: clock.now(),
        coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [], facts: { available: false }, artifact: null,
      }] };
  },
};
const planner: Planner = {
  identity: { provider: 'crash-fixture', model: 'synthetic', revision: '1' }, destination: 'local',
  capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000 },
  estimateInput(packet: ContextPacket, options: ModelCallOptions) {
    return { tokens: 100, bytes: new TextEncoder().encode(JSON.stringify({ packet, options })).byteLength, method: 'synthetic_fixed_100_tokens' };
  },
  async propose(packet, _signal, options) {
    ledger.prepare('INSERT INTO entries(kind,operation_id) VALUES(?,?)').run('model', options!.callId);
    return { status: 'ok', provider: 'crash-fixture', model: 'synthetic', inputTokens: 80, outputTokens: 20, proposal: proposal(packet, 'consumed') };
  },
};
const services: RuntimeServices = { state: repository, artifacts: new FileArtifactStore(join(directory, 'artifacts')), clock,
  planner, sink: new FakeSink(), ids: new RandomIds(), digester: new Sha256Digester(), tools: [tool] };
const contracts = new ToolContracts([tool], new AjvSchemas());
// A stable synthetic owner ensures post-restart dispatch is rejected by the budget fence, not by an unrelated owner mismatch.
const execution = new ExecutionRuntime(services, contracts, 'budget-crash-owner', 10000);
const planning = new PlanningRuntime(services, contracts, execution, execution.owner, { leaseMs: 10000, maxOutputTokens: 50 });
const parent = initial(parentId);
parent.goal.mode = 'deep'; parent.executionControl = newExecutionControl('deep');
const input = { id: childId, goal: structuredClone(parent.goal), policy: structuredClone(parent.policy),
  limits: { toolCalls: 4, modelCalls: 2, tokens: 500, replans: 4, wallTimeMs: 30000 } };
const create = () => execution.budgets.createChild(parentId, createCommand, actor, 1, input);
const budgetDenied = (error: unknown) => error instanceof Error && error.message.startsWith('budget_');

async function rejectNewAllocations() {
  const child = await execution.state(childId);
  await assert.rejects(planning.reserve(childId), budgetDenied);
  await assert.rejects(execution.submitPlan(childId, 'probe-new-plan', proposal({ stateRevision: child.revision, goal: child.goal, plan: child.plan }, 'probe')), budgetDenied);
}
async function finish() {
  const currentParent = await execution.state(parentId); const child = await execution.state(childId);
  const grant = currentParent.budgetGrants?.[0];
  process.send!({ type: 'finished', stage, parentId, childId, toolEntries: count('tool'), modelEntries: count('model'),
    phase: child.budgetParent!.phase, grantStatus: grant?.status, grantCount: currentParent.budgetGrants?.length ?? 0,
    exposure: totalExposure(currentParent), childUsage: child.budget.used, parentRevision: currentParent.revision, childRevision: child.revision });
}

try {
  if (stage === 'resume-create') {
    const before = await execution.state(childId);
    if (before.budgetParent!.phase === 'pending') {
      await assert.rejects(assertBudgetAuthority(services, before), budgetDenied);
      await rejectNewAllocations();
    }
    await create(); await create(); await finish();
  } else if (stage === 'resume-revoke') {
    const before = await execution.state(childId); const grantId = before.budgetParent!.grantId;
    await assert.rejects(assertBudgetAuthority(services, before), budgetDenied);
    await execution.budgets.revoke(parentId, grantId, revokeCommand, actor, 1);
    await execution.budgets.reconcile(parentId, grantId, actor);
    await create();
    await rejectNewAllocations();
    const child = await execution.state(childId);
    if (reservation === 'tool') await assert.rejects(execution.execute(childId, child.attempts.find(value => value.taskId === 'unsent')!.id), budgetDenied);
    else await assert.rejects(planning.execute(childId, child.modelCalls[1]!.id), budgetDenied);
    await execution.budgets.revoke(parentId, grantId, revokeCommand, actor, 1);
    await execution.budgets.reconcile(parentId, grantId, actor);
    await finish();
  } else {
    assert.equal((await raw.commit(command(parent, 'crash-parent-genesis'))).kind, 'committed');
    const child = await create();
    if (['parent-draining', 'child-fence', 'parent-settlement'].includes(stage)) {
      const call = await planning.reserve(childId); await planning.execute(childId, call.id);
      assert.equal(await planning.adopt(childId, call.id), true);
      const attempt = await execution.reserve(childId, 'consumed'); await execution.execute(childId, attempt.id);
      await execution.settlePending(attempt.id); await execution.adopt(childId, attempt.id);
      assert.equal(count('tool'), 1); assert.equal(count('model'), 1);
      if (reservation === 'tool') {
        const current = await execution.state(childId);
        await execution.submitPlan(childId, 'unsent-plan', proposal({ stateRevision: current.revision, goal: current.goal, plan: current.plan }, 'unsent'));
        await execution.reserve(childId, 'unsent');
      } else await planning.reserve(childId);
      await execution.budgets.revoke(parentId, child.budgetParent!.grantId, revokeCommand, actor, 1);
    }
    throw new Error(`crash_checkpoint_not_reached:${stage}`);
  }
} finally { await raw.close(); ledger.close(); }
