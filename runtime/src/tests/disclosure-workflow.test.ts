import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Evidence, Policy, WorkState } from '../domain/model.js';
import type { StateRepository } from '../application/ports.js';
import { WorkflowRuntime, type WorkflowRunResult } from '../application/workflow-runtime.js';
import { ConversationService } from '../application/conversation-service.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { PlanningRuntime } from '../application/planning-runtime.js';
import { OutboxDispatcher } from '../application/outbox.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { transact } from '../application/work-transactions.js';
import { ResumePacketSchema } from '../application/recovery-contracts.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { FakeClock, FakeSink, FixtureReadTool, ScriptedPlanner } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { adapters, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const actor = { tenantId: 'tenant-a', principalId: 'person-a' };
async function fixture(t: TestContext, adapter: Adapter, options: { channelDenied?: boolean; modelDenied?: boolean; deliveryRequired?: boolean; automatic?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'disclosure-workflow-')); let raw = openRepository(adapter, directory);
  t.after(async () => { await raw.close(); await rm(directory, { recursive: true, force: true }); });
  let receiptHook: ((commandId: string) => Promise<void>) | null = null;
  const state: StateRepository = { get: id => raw.get(id), async receipt(workId, commandId) { await receiptHook?.(commandId); return raw.receipt(workId, commandId); },
    commit: request => raw.commit(request), events: (id, after) => raw.events(id, after), deliveries: id => raw.deliveries(id),
    recentEventMetadata: (...args) => raw.recentEventMetadata(...args), conversationWorkPage: query => raw.conversationWorkPage(query),
    workIdsForConversation: (...args) => raw.workIdsForConversation(...args), runnable: now => raw.runnable(now), close: () => raw.close() };
  const seed = initial(); const policy: Policy = { ...seed.policy, allowedLabels: ['synthetic', 'secret'], allowedDestinations: ['local', 'channel'],
    disclosure: { revision: 'v1', maxReleasesPerWork: 5, maxReleasedBytesPerWork: 4096, destinations: [
      { destination: 'local', surfaces: options.modelDenied ? ['tool'] : ['model', 'tool'], allowedLabels: ['synthetic', 'secret'] },
      { destination: 'channel', surfaces: ['channel'], allowedLabels: options.channelDenied ? ['synthetic'] : ['synthetic', 'secret'] },
    ] } };
  const evidence: Evidence = { id: 'original', tenantId: actor.tenantId, scope: seed.goal.scope, sourceId: 'source', lineageId: 'source',
    locator: 'fixture://private-original', observedAt: 900, recordedAt: 1000, labels: ['synthetic', 'secret'], coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [],
    facts: { available: true }, artifact: null };
  const tool = new FixtureReadTool([evidence]); const planner = new ScriptedPlanner([packet => ({ status: 'ok', provider: 'scripted', model: 'fixture', inputTokens: 100, outputTokens: 30,
    proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0, reason: 'Read original', hypotheses: [],
      tasks: [{ id: 'read', description: 'Read the private original', toolId: 'fixture.read', toolVersion: '1', input: { evidenceIds: ['original'] },
        effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: packet.goal.criteria.map(c => c.id) }] } })]);
  const sink = new FakeSink(); const services = { state, artifacts: new MemoryArtifactStore(), clock: new FakeClock(1000), ids: new RandomIds(), digester: new Sha256Digester(), tools: [tool], planner, sink };
  const contracts = new ToolContracts([tool], new AjvSchemas()); const conversation = new ConversationService(services);
  const create = (owner: string) => { const execution = new ExecutionRuntime(services, contracts, owner); const planning = new PlanningRuntime(services, contracts, execution, owner);
    return { execution, planning, workflow: new WorkflowRuntime(services, execution, options.automatic === false ? null : planning, conversation, new OutboxDispatcher(services, owner)) }; };
  const current = create('first-owner');
  const accepted = await current.workflow.accept(actor, { messageId: 'request', binding: { ...actor, channel: 'test', conversationId: 'disclosure-chat', recipientId: actor.principalId, destination: 'channel' },
    goal: { ...seed.goal, description: 'SYNTHETIC_PRIVATE_GOAL' }, policy,
    limits: { ...seed.budget.limits, tokens: 1000000, wallTimeMs: 120000 }, completionRequiresDelivery: options.deliveryRequired ?? true });
  const mutate = (id: string, edit: (value: WorkState) => void) => transact(services, accepted.workId, id, 'policy_or_fixture_changed', { id }, edit);
  return { ...current, services, contracts, planner, sink, tool, evidence, workId: accepted.workId, mutate, create,
    onReceipt(hook: (commandId: string) => Promise<void>) { receiptHook = hook; }, clearReceiptHook() { receiptHook = null; },
    async reopen(owner = 'reopened-owner') { await raw.close(); raw = openRepository(adapter, directory); return create(owner); } };
}
async function checkpoint(f: Awaited<ReturnType<typeof fixture>>, result: WorkflowRunResult) {
  const state = (await f.services.state.get(f.workId))!;
  const packet = ResumePacketSchema.parse(JSON.parse(new TextDecoder().decode(await f.services.artifacts.get(result.checkpoint, state.policy))));
  assert.equal(packet.stateRevision, result.stateRevision); assert.equal(packet.stateRevision, state.revision);
  assert.equal(packet.runtime.status, state.status); return packet;
}

for (const adapter of adapters) {
  test(`${adapter}: initial model disclosure denial returns a durable blocked workflow and checkpoint`, async t => {
    const f = await fixture(t, adapter, { modelDenied: true }); const result = await f.workflow.run(f.workId, actor);
    assert.equal(result.control.kind, 'blocked'); assert.equal(result.reason, 'model_disclosure_denied'); await checkpoint(f, result);
    const state = (await f.services.state.get(f.workId))!; assert.equal(state.status, 'blocked'); assert.equal(state.modelCalls.length, 0);
    assert.equal(state.budget.used.modelCalls, 0); assert.equal(state.budget.reservedModelCalls, 0); assert.equal(state.budget.reservedTokens, 0);
    assert.equal(f.planner.inputs.length, 0); assert.equal(f.tool.invocations.length, 0);
  });

  test(`${adapter}: revoked reserved model is accounted as unused and resumes with one fresh call after reopen`, async t => {
    const f = await fixture(t, adapter); let revoked = false;
    const stopped = await f.workflow.run(f.workId, actor, { onStep: async () => {
      if (!revoked) { revoked = true; await f.mutate('revoke-model', state => { state.policy.disclosure!.destinations[0]!.surfaces = ['tool']; }); }
    } });
    assert.equal(stopped.control.kind, 'blocked'); assert.equal(stopped.reason, 'model_disclosure_denied'); const saved = await checkpoint(f, stopped);
    const state = (await f.services.state.get(f.workId))!; assert.equal(state.modelCalls.length, 1); const first = state.modelCalls[0]!;
    assert.equal(first.status, 'cancelled'); assert.equal(first.usageStatus, 'not_called'); assert.equal(first.reason, 'model_disclosure_denied');
    assert.equal(state.budget.reservedTokens, 0); assert.equal(state.budget.reservedModelCalls, 0); assert.equal(state.budget.used.modelCalls, 0);
    assert.equal(state.budget.used.tokens, 0); assert.equal(state.budget.used.unmeasuredModelCalls, 0); assert.equal(f.planner.inputs.length, 0);
    assert.equal(saved.runtime.modelCalls[0]!.usageStatus, 'not_called');
    const resumed = await f.reopen(); const repeat = await resumed.workflow.run(f.workId, actor, { previousPacket: stopped.checkpoint });
    assert.equal(repeat.reason, 'model_disclosure_denied'); assert.equal((await f.services.state.get(f.workId))!.modelCalls.length, 1); await checkpoint(f, repeat);
    await f.mutate('restore-model', current => { current.policy.disclosure!.destinations[0]!.surfaces = ['model', 'tool']; });
    await resumed.execution.command(f.workId, 'resume', actor, 1, { kind: 'resume', reason: 'Policy restored' });
    const completed = await resumed.workflow.run(f.workId, actor, { previousPacket: repeat.checkpoint });
    assert.equal(completed.control.kind, 'complete'); await checkpoint(f, completed);
    const final = (await f.services.state.get(f.workId))!; assert.equal(final.modelCalls.length, 2); assert.equal(final.modelCalls[0]!.usageStatus, 'not_called');
    assert.equal(final.budget.used.modelCalls, 1); assert.equal(final.budget.used.tokens, 130); assert.equal(f.planner.inputs.length, 1); assert.equal(f.tool.invocations.length, 1);
    assert.equal([...f.sink.delivered.values()].filter(delivery => delivery.kind === 'result').length, 1);
  });

  test(`${adapter}: disclosure changes inside dispatch preflight settle a known-unused reservation instead of escaping`, async t => {
    const f = await fixture(t, adapter); const reserved = await f.planning.reserve(f.workId);
    f.onReceipt(async id => { if (!id.startsWith('model-dispatch:')) return; f.clearReceiptHook();
      await f.mutate('dispatch-revocation', state => { state.policy.disclosure!.destinations[0]!.surfaces = ['tool']; }); });
    const result = await f.workflow.run(f.workId, actor); assert.equal(result.control.kind, 'blocked'); assert.equal(result.reason, 'model_disclosure_denied'); await checkpoint(f, result);
    const state = (await f.services.state.get(f.workId))!; assert.equal(state.modelCalls.find(call => call.id === reserved.id)!.usageStatus, 'not_called');
    assert.equal(state.budget.reservedModelCalls, 0); assert.equal(state.budget.reservedTokens, 0); assert.equal(state.budget.used.modelCalls, 0); assert.equal(f.planner.inputs.length, 0);
  });

  test(`${adapter}: required result channel denial persists blocked state and can resume delivery from checkpoint`, async t => {
    const f = await fixture(t, adapter, { channelDenied: true, automatic: false });
    await f.mutate('known-evidence', state => { state.evidence = [structuredClone(f.evidence)]; });
    const stopped = await f.workflow.run(f.workId, actor); assert.equal(stopped.control.kind, 'blocked'); assert.equal(stopped.reason, 'channel_disclosure_denied'); await checkpoint(f, stopped);
    assert.equal(f.sink.delivered.size, 0); assert.equal((await f.services.state.get(f.workId))!.status, 'blocked');
    assert.ok((await f.services.state.events(f.workId, 0)).some(event => event.type === 'workflow_channel_disclosure_denied'));
    const resumed = await f.reopen();
    await f.mutate('restore-channel', state => { state.policy.disclosure!.destinations[1]!.allowedLabels = ['synthetic', 'secret']; });
    await resumed.execution.command(f.workId, 'resume-channel', actor, 1, { kind: 'resume', reason: 'Channel policy restored' });
    const completed = await resumed.workflow.run(f.workId, actor, { previousPacket: stopped.checkpoint });
    assert.equal(completed.control.kind, 'complete'); await checkpoint(f, completed);
    assert.equal(f.planner.inputs.length, 0); assert.equal(f.tool.invocations.length, 0);
    assert.equal([...f.sink.delivered.values()].filter(delivery => delivery.kind === 'result').length, 1);
  });

  test(`${adapter}: completed analysis keeps its terminal state while unavailable channel yields an undelivered response`, async t => {
    const f = await fixture(t, adapter, { channelDenied: true, deliveryRequired: false, automatic: false });
    await f.mutate('complete-evidence', state => { state.evidence = [structuredClone(f.evidence)]; });
    const stopped = await f.workflow.run(f.workId, actor); assert.equal(stopped.control.kind, 'yield'); assert.equal(stopped.reason, 'channel_disclosure_denied');
    assert.equal((await checkpoint(f, stopped)).runtime.status, 'completed'); assert.equal(f.sink.delivered.size, 0);
    const events = (await f.services.state.events(f.workId, 0)).filter(event => event.type === 'workflow_channel_disclosure_denied').length;
    const repeated = await f.workflow.run(f.workId, actor, { previousPacket: stopped.checkpoint });
    assert.equal(repeated.reason, 'channel_disclosure_denied'); assert.equal((await checkpoint(f, repeated)).runtime.status, 'completed');
    assert.equal((await f.services.state.events(f.workId, 0)).filter(event => event.type === 'workflow_channel_disclosure_denied').length, events);
    await f.mutate('completed-channel-restored', state => { state.policy.disclosure!.destinations[1]!.allowedLabels = ['synthetic', 'secret']; });
    const delivered = await f.workflow.run(f.workId, actor, { previousPacket: repeated.checkpoint });
    assert.equal(delivered.control.kind, 'complete'); assert.equal((await checkpoint(f, delivered)).runtime.status, 'completed');
    assert.equal([...f.sink.delivered.values()].filter(value => value.kind === 'result').length, 1);
  });

  test(`${adapter}: an unsuccessful resume under unchanged channel policy blocks again without becoming runnable`, async t => {
    const f = await fixture(t, adapter, { channelDenied: true, automatic: false });
    const first = await f.workflow.run(f.workId, actor); assert.equal(first.reason, 'channel_disclosure_denied'); await checkpoint(f, first);
    await f.execution.command(f.workId, 'resume-before-policy-change', actor, 1, { kind: 'resume', reason: 'Explicit retry' });
    const second = await f.workflow.run(f.workId, actor, { previousPacket: first.checkpoint }); assert.equal(second.control.kind, 'blocked'); await checkpoint(f, second);
    assert.equal((await f.services.state.get(f.workId))!.status, 'blocked'); assert.equal((await f.services.state.runnable(f.services.clock.now())).includes(f.workId), false);
    assert.equal(f.planner.inputs.length, 0); assert.equal(f.tool.invocations.length, 0);
  });

  for (const action of ['cancel', 'pause'] as const) test(`${adapter}: simultaneous ${action} and disclosure revocation preserve user control and unused accounting`, async t => {
    const f = await fixture(t, adapter); let changed = false;
    const result = await f.workflow.run(f.workId, actor, { onStep: async () => { if (changed) return; changed = true;
      await f.execution.command(f.workId, action, actor, 1, { kind: action, reason: `User ${action}` });
      await f.mutate(`revoke-${action}`, state => { state.policy.disclosure!.destinations = []; });
    } });
    assert.equal(result.control.kind, action === 'cancel' ? 'cancelled' : 'paused'); assert.equal(result.reason, `User ${action}`); await checkpoint(f, result);
    const state = (await f.services.state.get(f.workId))!; assert.equal(state.budget.reservedTokens, 0); assert.equal(state.budget.reservedModelCalls, 0);
    assert.equal(state.budget.used.modelCalls, 0); assert.equal(f.planner.inputs.length, 0); assert.equal(f.tool.invocations.length, 0);
  });
}
