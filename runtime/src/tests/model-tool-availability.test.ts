import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContextPacket, Evidence, ModelCall, TaskSpec, WorkState } from '../domain/model.js';
import type { ModelCallOptions, ModelReply, Planner, Tool, ToolAvailability } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { PlanningRuntime } from '../application/planning-runtime.js';
import { createExecutionAuthority } from '../application/execution-authority.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { readGeneratedAnswer } from '../application/generated-answer.js';
import { asJson } from '../application/plan-validator.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, FixtureReadTool, SequenceIds } from '../infrastructure/fakes.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { command, initial } from './state-conformance-helpers.js';
import { windowFixture } from './session-window-helpers.js';
import { fixture as turnFixture, replaceTurn, answer } from './agent-turn-flow-helpers.js';

const limits = { callId: 'availability-inspection', maxInputBytes: 1000000, maxInputTokens: 1000000, maxOutputTokens: 128 };
const task = (id = 'read', toolId = 'fixture.read', dependsOn: string[] = [], satisfies: string[] = ['criterion']): TaskSpec => ({
  id, description: 'Read a fixed synthetic original', dependsOn, toolId, toolVersion: '1', input: { evidenceIds: ['original'] }, effect: 'read', maxAttempts: 1, satisfies,
});
/** Replace only host metadata through the real catalog revision; definition/version and callback remain identical. */
function availability(contracts: ToolContracts, mode: ToolAvailability, id = 'fixture.read') {
  const target = contracts.get(id, '1'); assert.ok(target);
  const provider = target.tool.definition.provider;
  const entries = contracts.visible({ tenantId: 'tenant-a', principalId: 'person-a', allowedTools: ['fixture.read', 'fixture.next'],
    allowedLabels: ['synthetic', 'public'], allowedDestinations: ['local'], allowWrites: false }).filter(definition => definition.provider === provider);
  const replacement: Tool[] = entries.map(definition => {
    const current = contracts.get(definition.id, definition.version)!.tool;
    return definition.id === id ? { ...current, availability: mode } : current;
  });
  assert.ok(replacement.some(tool => tool.definition.id === id));
  contracts.replaceProvider(provider, replacement, { expectedEpoch: contracts.providerEpoch(provider), sourceRevision: `availability-${contracts.revision}` });
}
async function fixture(twoTools = false) {
  const state = new MemoryStateRepository(), artifacts = new MemoryArtifactStore(), digester = new Sha256Digester(), clock = new FakeClock(1100);
  const work = initial('model-availability'); work.budget.limits.tokens = 1000000;
  if (twoTools) work.policy.allowedTools.push('fixture.next');
  const record: Evidence = { id: 'original', tenantId: work.policy.tenantId, scope: work.goal.scope, sourceId: 'original', lineageId: 'original',
    locator: 'fixture://original', observedAt: 1000, recordedAt: 1000, labels: ['synthetic'], coverage: 'complete', status: 'accepted',
    supersedes: [], derivedFrom: [], facts: { available: false }, artifact: null };
  const read = new FixtureReadTool([record]);
  const tools: Tool[] = [read, ...(twoTools ? [{ definition: { ...read.definition, id: 'fixture.next' }, execute: read.execute.bind(read) }] : [])];
  const contracts = new ToolContracts(tools, new AjvSchemas()), invocations: { packet: ContextPacket; options: ModelCallOptions }[] = [];
  const planner: Planner = { identity: { provider: 'synthetic', model: 'availability', revision: '1' }, destination: 'local',
    capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000 },
    inputEstimation: { id: 'availability-fixture', revision: '1', templateRevision: '1', kind: 'tokenizer' },
    estimateInput: (packet, options) => ({ tokens: 1000, bytes: Buffer.byteLength(JSON.stringify({ packet, options })), method: 'synthetic_envelope' }),
    async propose(packet, _signal, options): Promise<ModelReply> {
      assert.ok(options); invocations.push(structuredClone({ packet, options }));
      return { status: 'ok', provider: 'synthetic', model: 'availability', inputTokens: 19, outputTokens: 7,
        proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
          reason: 'Read the fixed source', hypotheses: [], tasks: [task()] } };
    },
  };
  const services: RuntimeServices = { state, artifacts, digester, clock, ids: new SequenceIds(), planner, tools, sink: new FakeSink(),
    executionAuthority: createExecutionAuthority({ actor: work.policy, scope: work.goal.scope, signal: new AbortController().signal }) };
  assert.equal((await state.commit(command(work, 'accept'))).kind, 'committed');
  const execution = new ExecutionRuntime(services, contracts, 'worker'), planning = new PlanningRuntime(services, contracts, execution, 'planner', { maxOutputTokens: 128, leaseMs: 10000 });
  return { services, contracts, execution, planning, invocations, workId: work.id, read,
    current: () => execution.state(work.id), input: (call: ModelCall) => artifacts.get(call.inputArtifact, work.policy) };
}
function unreserved(state: WorkState) {
  assert.equal(state.budget.reservedModelCalls, 0); assert.equal(state.budget.reservedTokens, 0);
  assert.equal(state.budget.used.tokens, 0); assert.equal(state.budget.used.unmeasuredModelCalls, 0);
}

for (const boundary of ['reserve_edit', 'reserve_before_commit', 'dispatch_edit', 'dispatch_before_commit'] as const)
  test(`${boundary}: availability replacement prevents a model dispatch without spending its reservation`, async () => {
    const f = await fixture(), dispatch = boundary.startsWith('dispatch');
    const call = dispatch ? await f.planning.reserve(f.workId) : null, original = call ? await f.input(call) : null;
    const receipt = f.services.state.receipt.bind(f.services.state), exists = f.services.artifacts.exists.bind(f.services.artifacts);
    let inTransaction = false, changed = false;
    const change = () => { if (!changed) { changed = true; availability(f.contracts, 'stored_only'); } };
    f.services.state.receipt = async (workId, commandId) => {
      const value = await receipt(workId, commandId);
      if (commandId.startsWith(dispatch ? 'model-dispatch:' : 'model-reserve:')) {
        inTransaction = true; if (boundary.endsWith('_edit')) change();
      }
      return value;
    };
    f.services.artifacts.exists = async ref => {
      const value = await exists(ref); if (inTransaction && boundary.endsWith('_before_commit')) change(); return value;
    };
    if (call) assert.equal(await f.planning.dispatch(f.workId, call.id), false);
    else await assert.rejects(f.planning.reserve(f.workId), boundary === 'reserve_edit' ? /model_reservation_stale/ : /context_state_changed/);
    assert.equal(changed, true, 'the selected asynchronous boundary must be reached');
    const current = await f.current(); assert.equal(f.invocations.length, 0); assert.equal(current.budget.used.modelCalls, 0); unreserved(current);
    if (call) {
      const saved = current.modelCalls.find(value => value.id === call.id)!;
      assert.equal(saved.status, 'cancelled'); assert.equal(saved.usageStatus, 'not_called'); assert.equal(saved.reason, 'model_tools_changed');
      assert.deepEqual(saved.inputArtifact, call.inputArtifact); assert.deepEqual(await f.input(call), original);
      assert.equal(await f.services.state.receipt(f.workId, `model-dispatch:${call.id}`), null);
    } else assert.deepEqual(current.modelCalls, []);
  });

for (const boundary of ['source_await', 'final_state_await'] as const)
  test(`${boundary}: a post-dispatch availability replacement reaches no provider and preserves zero reported token usage`, async () => {
    const f = await fixture(), call = await f.planning.reserve(f.workId), original = await f.input(call);
    const sources = f.planning.context.sourcesCurrent.bind(f.planning.context), definitions = f.planning.context.definitionsCurrent.bind(f.planning.context), get = f.services.state.get.bind(f.services.state);
    let sourceReturned = false, replaceOnGet = false, changed = false;
    f.planning.context.sourcesCurrent = async (...args) => {
      const result = await sources(...args); sourceReturned = true;
      if (boundary === 'source_await') { changed = true; availability(f.contracts, 'stored_only'); }
      return result;
    };
    f.planning.context.definitionsCurrent = (...args) => {
      const result = definitions(...args);
      if (boundary === 'final_state_await' && sourceReturned && !changed) replaceOnGet = true;
      return result;
    };
    f.services.state.get = async workId => {
      const value = await get(workId);
      if (replaceOnGet && !changed) { changed = true; replaceOnGet = false; availability(f.contracts, 'stored_only'); }
      return value;
    };
    await f.planning.execute(f.workId, call.id); await f.planning.settlePending();
    assert.equal(changed, true); assert.equal(f.invocations.length, 0);
    const current = await f.current(), saved = current.modelCalls[0]!;
    assert.equal(saved.status, 'received'); assert.equal(saved.outcome, 'cancelled'); assert.equal(saved.usageStatus, 'reported');
    assert.equal(saved.inputTokens, 0); assert.equal(saved.outputTokens, 0); unreserved(current);
    assert.equal(current.budget.used.modelCalls, 1, 'the existing ledger retains the already committed dispatch');
    assert.deepEqual(await f.input(call), original); assert.deepEqual(saved.inputArtifact, call.inputArtifact);
  });

for (const phase of ['running', 'received'] as const) test(`a ${phase} model call keeps its reply proof and known usage after the same definition becomes stored-only`, async () => {
  const f = await fixture(), call = await f.planning.reserve(f.workId);
  if (phase === 'running') {
    const propose = f.services.planner.propose.bind(f.services.planner);
    f.services.planner.propose = async (...args) => {
      const reply = await propose(...args); assert.equal((await f.current()).modelCalls[0]!.status, 'running');
      availability(f.contracts, 'stored_only'); return reply;
    };
  }
  await f.planning.execute(f.workId, call.id);
  const received = await f.current(); assert.equal(received.modelCalls[0]!.status, 'received');
  const input = JSON.parse(Buffer.from(await f.input(call)).toString()) as { packet: ContextPacket; options: ModelCallOptions };
  if (phase === 'received') availability(f.contracts, 'stored_only');
  assert.equal(f.planning.context.definitionsCurrent(input.packet, input.options, received), true);
  assert.equal(f.planning.context.outgoingDefinitionsCurrent(input.packet, input.options, received), false);
  assert.equal(await f.planning.adopt(f.workId, call.id), true); assert.equal(await f.planning.adopt(f.workId, call.id), true);
  const current = await f.current(); assert.equal(current.modelCalls[0]!.status, 'accepted'); assert.equal(current.budget.used.tokens, 26);
  assert.equal(current.budget.used.modelCalls, 1); assert.equal(f.invocations.length, 1);
  assert.deepEqual(current.modelCalls[0]!.replyArtifact, received.modelCalls[0]!.replyArtifact);
  assert.equal(f.execution.control(current).kind, 'wait'); assert.equal(f.execution.control(current).reason, 'connection_required');
});

test('a completed dependency and its source contract stay in context while only callable definitions enter the next request', async () => {
  const f = await fixture(true), before = await f.current(), first = task('first', 'fixture.read', [], []), second = task('second', 'fixture.next', ['first']);
  await f.execution.submitPlan(f.workId, 'two-step-plan', { baseStateRevision: before.revision, baseGoalRevision: 1, basePlanRevision: 0,
    reason: 'Preserve a completed dependency', hypotheses: [], tasks: [first, second] });
  const attempt = await f.execution.reserve(f.workId, first.id); await f.execution.execute(f.workId, attempt.id);
  const settled = await f.execution.adopt(f.workId, attempt.id); assert.equal(settled.attempts.find(value => value.id === attempt.id)!.adopted, true);
  availability(f.contracts, 'stored_only'); const state = await f.current(), prepared = await f.planning.context.prepare(state, limits);
  assert.deepEqual(prepared.packet.plan!.tasks.map(value => value.id), ['first', 'second']);
  assert.ok(prepared.packet.toolObservations!.some(value => value.attemptId === attempt.id));
  assert.deepEqual(prepared.options.tools.map(value => value.id), ['fixture.next']); assert.deepEqual(prepared.packet.activeToolIds, ['fixture.next']);
  assert.deepEqual(prepared.packet.policy.allowedTools, ['fixture.next']);
  assert.equal(prepared.frame.basis.toolsDigest, f.services.digester.digest(asJson(f.contracts.visible(state.policy))));
  assert.equal(f.planning.context.definitionsCurrent(prepared.packet, prepared.options, state), true);
});

test('an inspect handle refuses a catalog revision change before session or frame publication', async t => {
  const f = await windowFixture(t, 2), context = f.context, before = await f.current();
  const inspection = await context.inspect(before, limits); assert.equal(inspection.kind, 'fits');
  assert.equal((await f.repository.get(f.session.scope)).head, null);
  let puts = 0, heads = 0; const put = f.services.artifacts.put.bind(f.services.artifacts), publish = f.repository.publishHead.bind(f.repository);
  f.services.artifacts.put = async (...args) => { puts++; return put(...args); };
  f.repository.publishHead = async (...args) => { heads++; return publish(...args); };
  availability(f.contracts, 'stored_only');
  await assert.rejects(context.materialize(inspection), /context_state_changed/);
  assert.equal(puts, 0); assert.equal(heads, 0); assert.deepEqual(await f.current(), before);
});

test('inspectNext discards a fits cache after a same-definition availability replacement', async t => {
  const f = await windowFixture(t, 2), planning = f.compactPlanning!; assert.ok(planning);
  let inspections = 0; const inspect = planning.context.inspect.bind(planning.context);
  planning.context.inspect = async (...args) => { inspections++; return inspect(...args); };
  assert.equal(await planning.compactStep(f.workId), null); assert.equal(inspections, 1);
  const before = await f.current(); availability(f.contracts, 'stored_only');
  const call = await planning.reserve(f.workId); assert.equal(inspections, 2);
  const raw = await f.services.artifacts.get(call.inputArtifact, before.policy), input = JSON.parse(Buffer.from(raw).toString()) as { packet: ContextPacket; options: ModelCallOptions };
  assert.deepEqual(input.options.tools, []); assert.deepEqual(input.packet.activeToolIds, []);
  assert.equal(f.planner.inputs.length, 0); assert.equal((await f.current()).budget.used.modelCalls, 0);
});

test('connection wait skips automatic compact but an explicit compact request remains available', async t => {
  const f = await windowFixture(t, 6), planning = f.compactPlanning!, state = await f.current();
  await f.runtime.submitPlan(f.workId, 'read-plan', { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision, basePlanRevision: 0,
    reason: 'Need a connected source', hypotheses: [], tasks: [task()] });
  availability(f.contracts, 'stored_only');
  let preparations = 0; const prepare = f.sessions.prepareCompact.bind(f.sessions);
  f.sessions.prepareCompact = async (...args) => { preparations++; return prepare(...args); };
  const before = await f.current(), control = f.runtime.control(before); assert.equal(control.kind, 'wait'); assert.equal(control.reason, 'connection_required');
  assert.equal(await planning.compactStep(f.workId), null); assert.equal(preparations, 0); assert.deepEqual(await f.current(), before);
  const call = await planning.requestCompact(f.workId, { requestId: 'explicit-offline-compact', force: true });
  assert.ok(call); assert.equal(call.purpose, 'session_compact'); assert.equal(preparations, 1); assert.equal(f.planner.inputs.length, 0);
});

for (const phase of ['reserved', 'received'] as const)
  test(`agent turn ${phase}: callable transmission checks do not become stored-answer checks`, { timeout: 60000 }, async () => {
    const f = await turnFixture(); let invocations = 0;
    try {
      replaceTurn(f.profile, async input => { invocations++; return answer(input, 'The original answer remains valid.'); });
      const planning = f.profile.planning!, accepted = await f.accept('Explain this fixed test request.', 'availability-turn', 'deep');
      const call = await planning.reserve(accepted.workId); assert.equal(call.purpose, 'agent_turn');
      const original = await planning.services.artifacts.get(call.inputArtifact, f.profile.policy);
      assert.ok(JSON.parse(Buffer.from(original).toString()).options.tools.some((definition: { id: string }) => definition.id === 'fixture.read'));
      if (phase === 'received') await planning.execute(accepted.workId, call.id);
      availability(planning.tools, 'stored_only');
      if (phase === 'reserved') {
        assert.equal(await planning.dispatch(accepted.workId, call.id), false);
        const state = await f.profile.runtime.state(accepted.workId); assert.equal(state.modelCalls[0]!.reason, 'model_tools_changed');
        assert.equal(invocations, 0); assert.equal(state.budget.used.modelCalls, 0); unreserved(state);
      } else {
        assert.equal(await planning.adopt(accepted.workId, call.id), true); assert.equal(await planning.adopt(accepted.workId, call.id), true);
        const state = await f.profile.runtime.state(accepted.workId);
        assert.equal((await readGeneratedAnswer(planning.services, state))?.text, 'The original answer remains valid.');
        assert.equal(state.budget.used.modelCalls, 1); assert.equal(state.budget.used.tokens, 10); assert.equal(invocations, 1);
      }
      assert.deepEqual(await planning.services.artifacts.get(call.inputArtifact, f.profile.policy), original);
    } finally { await f.close(); }
  });
