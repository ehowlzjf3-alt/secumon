import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type { ContextPacket, ModelCall } from '../domain/model.js';
import { readCollectionContext } from '../domain/context.js';
import { ContextPacketSchema } from '../application/contracts.js';
import { buildContextPacket } from '../application/context-packet.js';
import { PlanningRuntime } from '../application/planning-runtime.js';
import { asJson } from '../application/plan-validator.js';
import { transact } from '../application/work-transactions.js';
import { createAgentTurnPrompt, matchesAgentTurnPrompt } from '../infrastructure/agent-turn-prompt.js';
import { StructuredPlannerAdapter, type StructuredPlannerRequest } from '../infrastructure/structured-planner.js';
import { adapters, type Adapter } from './state-conformance-helpers.js';
import { bodyMarker, contextOptions, cursorMarker, resumeOptionFixture } from './read-resume-option-helpers.js';

type Fixture = Awaited<ReturnType<typeof resumeOptionFixture>>;
async function fixture(t: TestContext, complete = true, backend: Adapter = 'sqlite') {
  const f = await resumeOptionFixture(backend, complete);
  t.after(async () => { try { await f.closeState(); } finally { await rm(f.directory, { recursive: true, force: true }); } });
  return f;
}
function availability(f: Fixture, mode: 'available' | 'stored_only') {
  const tool = f.contracts.get(f.task.toolId, f.task.toolVersion)!.tool;
  f.contracts.replaceProvider('fixture', [{ ...tool, availability: mode }], {
    expectedEpoch: f.contracts.providerEpoch('fixture'), sourceRevision: `${mode}-${f.contracts.revision}`,
  });
}
async function input(f: Fixture, call: ModelCall): Promise<ContextPacket> {
  return (JSON.parse(new TextDecoder().decode(await f.artifacts.get(call.inputArtifact, (await f.runtime.state('work-1')).policy))) as { packet: ContextPacket }).packet;
}
function loseRaw(f: Fixture) {
  const get = f.services.artifacts.get.bind(f.services.artifacts);
  f.services.artifacts.get = async (ref, policy) => { if (ref.id === f.raw.id) throw new Error('fixture_original_unavailable'); return get(ref, policy); };
}
function planning(f: Fixture) {
  return new PlanningRuntime(f.services, f.contracts, f.runtime, 'resume-model', { maxOutputTokens: 100, maxInputBytes: 100000 }, f.compiler);
}
async function received(f: Fixture) {
  const p = planning(f), call = await p.reserve('work-1');
  await p.execute('work-1', call.id);
  const state = await f.runtime.state('work-1'), saved = state.modelCalls.find(value => value.id === call.id)!;
  assert.equal(saved.status, 'received'); assert.equal(saved.usageStatus, 'reported');
  assert.equal(state.budget.used.tokens, 18); assert.equal(state.budget.used.modelCalls, 1);
  return { p, call, state, saved };
}

test('resume option is optional and strict; old packet JSON is preserved without a default marker', async t => {
  const f = await fixture(t), state = await f.runtime.state('work-1'), packet = buildContextPacket(state, f.contracts);
  assert.deepEqual(ContextPacketSchema.parse(packet), packet);
  assert.equal(Object.hasOwn(packet.readCollections![0]!, 'resumeMode'), false);
  const marked = structuredClone(packet); marked.readCollections![0]!.resumeMode = 'stored_complete';
  assert.deepEqual(ContextPacketSchema.parse(marked), marked);
  for (const extra of [{ resumeMode: 'available' }, { resumeMode: null }, { resumeMode: 'stored_complete', permit: true }]) {
    const invalid = structuredClone(packet); Object.assign(invalid.readCollections![0]!, extra);
    assert.equal(ContextPacketSchema.safeParse(invalid).success, false);
  }
});

for (const backend of adapters) test(`${backend}: a complete original becomes a planning option online and stored-only without changing canonical state`, async t => {
  const f = await fixture(t, true, backend), state = await f.runtime.state('work-1'), canonical = readCollectionContext(state);
  const before = f.services.digester.digest(asJson(state));
  const online = await f.compiler.prepare(state, contextOptions);
  assert.equal(online.packet.readCollections![0]!.resumeMode, 'stored_complete');
  availability(f, 'stored_only');
  const stored = await f.compiler.prepare(state, contextOptions);
  assert.deepEqual(stored.packet.readCollections, online.packet.readCollections);
  assert.deepEqual(stored.packet.plan!.tasks, [f.task]);
  assert.deepEqual(stored.options.tools, []); assert.deepEqual(stored.packet.activeToolIds, []);
  assert.deepEqual(stored.packet.readCollections!.map(({ resumeMode: _mode, ...row }) => row), canonical);
  assert.deepEqual(stored.frame.packet.readCollections, stored.packet.readCollections);
  assert.equal(f.services.digester.digest(asJson(await f.runtime.state('work-1'))), before);
  assert.equal(f.entries(), 0); assert.equal(f.planner.inputs.length, 0);
  assert.equal(JSON.stringify(stored.packet).includes(bodyMarker), false);
  assert.equal(JSON.stringify(stored.packet).includes(cursorMarker), false);
});

test('a partial checkpoint gets no complete option and a forged mode is rejected by both currentness paths', async t => {
  const f = await fixture(t, false), state = await f.runtime.state('work-1'), prepared = await f.compiler.prepare(state, contextOptions);
  assert.equal(Object.hasOwn(prepared.packet.readCollections![0]!, 'resumeMode'), false);
  const forged = structuredClone(prepared.packet); forged.readCollections![0]!.resumeMode = 'stored_complete';
  assert.equal(f.compiler.definitionsCurrent(forged, prepared.options, state), false);
  assert.equal(await f.compiler.sourcesCurrent(forged, state), false);
  assert.equal(await f.compiler.sourcesCurrent(prepared.packet, state), true);
});

test('an original absent from the current frontier is never reconstructed from checkpoint metadata', async t => {
  const f = await fixture(t);
  await transact(f.services, 'work-1', 'empty-frontier', 'fixture_frontier_changed', {}, next => { next.plan!.tasks = []; });
  const state = await f.runtime.state('work-1'), prepared = await f.compiler.prepare(state, contextOptions);
  assert.deepEqual(prepared.packet.plan!.tasks, []);
  assert.equal(prepared.packet.readCollections![0]!.resumeMode, undefined);
  assert.equal(prepared.packet.readCollections![0]!.progress.phase, 'complete');
  assert.equal(await f.compiler.sourcesCurrent(prepared.packet, state), true); assert.equal(f.entries(), 0);
});

test('the complete option and exact frontier are mandatory at the minimum context size; inspection never writes a replacement', async t => {
  const f = await fixture(t); availability(f, 'stored_only'); const state = await f.runtime.state('work-1');
  let writes = 0; const put = f.services.artifacts.put.bind(f.services.artifacts);
  f.services.artifacts.put = async (...args) => { writes++; return put(...args); };
  const baseline = await f.compiler.inspect(state, contextOptions); assert.equal(baseline.kind, 'fits');
  const tooSmall = await f.compiler.inspect(state, { ...contextOptions, maxInputBytes: baseline.requiredEstimate.bytes - 1 });
  assert.equal(tooSmall.kind, 'required_overflow'); assert.equal(writes, 0);
  const exact = await f.compiler.inspect(state, { ...contextOptions, maxInputBytes: baseline.requiredEstimate.bytes });
  assert.equal(exact.kind, 'fits'); assert.equal(writes, 0);
  const prepared = await f.compiler.materialize(exact);
  assert.equal(prepared.packet.readCollections![0]!.resumeMode, 'stored_complete');
  assert.deepEqual(prepared.packet.plan!.tasks, [f.task]); assert.equal(writes, 1); assert.equal(f.entries(), 0);
  assert.deepEqual(await f.runtime.state('work-1'), state);
});

test('canonical four fields, original query and supplied frontier remain mandatory under the annotation', async t => {
  const f = await fixture(t), state = await f.runtime.state('work-1'), prepared = await f.compiler.prepare(state, contextOptions);
  const variants = [
    (packet: ContextPacket) => { packet.readCollections![0]!.progress.completedItems++; },
    (packet: ContextPacket) => { packet.readCollections![0]!.attemptStatus = 'partial'; },
    (packet: ContextPacket) => { packet.readCollections = []; },
    (packet: ContextPacket) => { packet.plan!.tasks = []; },
    (packet: ContextPacket) => { packet.plan!.tasks[0]!.input = { fabricated: true }; },
  ];
  for (const edit of variants) {
    const altered = structuredClone(prepared.packet); edit(altered);
    assert.equal(f.compiler.definitionsCurrent(altered, prepared.options, state), false);
    assert.equal(await f.compiler.sourcesCurrent(altered, state), false);
  }
  const legacy = structuredClone(prepared.packet); delete legacy.readCollections![0]!.resumeMode;
  assert.equal(f.compiler.definitionsCurrent(legacy, prepared.options, state), true);
  assert.equal(await f.compiler.sourcesCurrent(legacy, state), true);
});

test('one marked source verification reuses its checkpoint proof rather than rereading dispatch or raw for the annotation', async t => {
  const f = await fixture(t), state = await f.runtime.state('work-1'), prepared = await f.compiler.prepare(state, contextOptions);
  const get = f.services.artifacts.get.bind(f.services.artifacts), receipt = f.services.state.receipt.bind(f.services.state);
  let rawReads = 0, dispatchReads = 0;
  f.services.artifacts.get = async (ref, policy) => { if (ref.id === f.raw.id) rawReads++; return get(ref, policy); };
  f.services.state.receipt = async (workId, commandId) => { if (commandId === `dispatch:${f.attemptId}`) dispatchReads++; return receipt(workId, commandId); };
  assert.equal(await f.compiler.sourcesCurrent(prepared.packet, state), true);
  assert.equal(rawReads, 1); assert.equal(dispatchReads, 1); assert.equal(f.entries(), 0);
});

test('availability alone cannot invalidate a stored complete option, while missing original bytes do', async t => {
  const f = await fixture(t), state = await f.runtime.state('work-1'), prepared = await f.compiler.prepare(state, contextOptions);
  availability(f, 'stored_only');
  assert.equal(f.compiler.definitionsCurrent(prepared.packet, prepared.options, state), true);
  assert.equal(await f.compiler.sourcesCurrent(prepared.packet, state), true);
  assert.equal(f.compiler.outgoingDefinitionsCurrent(prepared.packet, prepared.options, state), false);
  loseRaw(f);
  assert.equal(await f.compiler.sourcesCurrent(prepared.packet, state), false); assert.equal(f.entries(), 0);
});

test('a state change during original-page verification cannot authenticate the earlier complete option', async t => {
  const f = await fixture(t), state = await f.runtime.state('work-1'), prepared = await f.compiler.prepare(state, contextOptions);
  const get = f.services.artifacts.get.bind(f.services.artifacts); let changed = false;
  f.services.artifacts.get = async (ref, policy) => {
    const bytes = await get(ref, policy);
    if (ref.id === f.raw.id && !changed) {
      changed = true;
      await transact(f.services, state.id, 'later-state', 'fixture_state_changed', {}, next => { next.statusReason = 'later-state'; });
    }
    return bytes;
  };
  assert.equal(await f.compiler.sourcesCurrent(prepared.packet, state), false); assert.equal(changed, true);
  assert.equal(f.entries(), 0);
});

test('legacy planning adopts an explicit successor after availability changes without rewriting parent ownership, originals or model usage', async t => {
  const f = await fixture(t), { p, call, state, saved } = await received(f), packet = await input(f, call);
  assert.equal(packet.readCollections![0]!.resumeMode, 'stored_complete');
  const parent = state.attempts.find(value => value.id === f.attemptId)!;
  availability(f, 'stored_only');
  assert.equal(await p.adopt('work-1', call.id), true); assert.equal(await p.adopt('work-1', call.id), true);
  const adopted = await f.runtime.state('work-1');
  assert.deepEqual(adopted.plan!.tasks[0]!.readResume, { attemptId: f.attemptId, checkpointId: f.head.id });
  assert.equal(adopted.plan!.tasks[0]!.id, 'resume-task'); assert.deepEqual(adopted.plan!.tasks[0]!.input, f.task.input);
  assert.deepEqual(adopted.attempts.find(value => value.id === f.attemptId), parent);
  assert.deepEqual(adopted.modelCalls[0]!.inputArtifact, call.inputArtifact);
  assert.deepEqual(adopted.modelCalls[0]!.replyArtifact, saved.replyArtifact);
  assert.equal(adopted.modelCalls[0]!.status, 'accepted'); assert.equal(adopted.budget.used.tokens, 18);
  assert.equal(adopted.budget.used.modelCalls, 1); assert.equal(f.planner.inputs.length, 1); assert.equal(f.entries(), 0);
});

for (const boundary of ['before_adopt', 'before_commit'] as const)
  test(`${boundary}: losing a marked original rejects only the plan body and preserves known accounting`, async t => {
    const f = await fixture(t), { p, call, state, saved } = await received(f);
    let injected = false;
    if (boundary === 'before_adopt') { loseRaw(f); injected = true; }
    else {
      const receipt = f.services.state.receipt.bind(f.services.state);
      f.services.state.receipt = async (workId, commandId) => {
        const value = await receipt(workId, commandId);
        if (commandId === `model-adopt:${call.id}` && !injected) { injected = true; loseRaw(f); }
        return value;
      };
    }
    assert.equal(await p.adopt('work-1', call.id), false); assert.equal(injected, true);
    const rejected = await f.runtime.state('work-1'), result = rejected.modelCalls[0]!;
    assert.equal(result.status, 'rejected'); assert.equal(result.reason, 'model_collection_input_changed');
    assert.equal(result.usageStatus, 'reported'); assert.equal(result.inputTokens, 13); assert.equal(result.outputTokens, 5);
    assert.deepEqual(result.inputArtifact, call.inputArtifact); assert.deepEqual(result.replyArtifact, saved.replyArtifact);
    assert.deepEqual(rejected.plan, state.plan); assert.equal(rejected.budget.used.tokens, 18); assert.equal(rejected.budget.used.modelCalls, 1);
    assert.equal(await f.services.state.receipt('work-1', `model-adopt:${call.id}`), null);
    assert.equal(f.planner.inputs.length, 1); assert.equal(f.entries(), 0);
  });

for (const failure of ['missing', 'same_length_tampering'] as const)
  test(`${failure}: a received legacy input must authenticate before deciding that its marker is absent`, async t => {
    const f = await fixture(t), { p, call, state } = await received(f), get = f.services.artifacts.get.bind(f.services.artifacts);
    let inputReads = 0;
    f.services.artifacts.get = async (ref, policy) => {
      if (ref.id !== call.inputArtifact.id) return get(ref, policy);
      inputReads++;
      if (failure === 'missing') throw new Error('fixture_input_missing');
      const bytes = await get(ref, policy), text = new TextDecoder().decode(bytes);
      assert.ok(text.includes('Retrieve'));
      const changed = new TextEncoder().encode(text.replace('Retrieve', 'Retrieva'));
      assert.equal(changed.byteLength, bytes.byteLength); return changed;
    };
    assert.equal(await p.adopt('work-1', call.id), false); assert.equal(inputReads, 1);
    const rejected = await f.runtime.state('work-1');
    assert.equal(rejected.modelCalls[0]!.reason, 'model_input_invalid'); assert.deepEqual(rejected.plan, state.plan);
    assert.equal(rejected.budget.used.tokens, 18); assert.equal(rejected.budget.used.modelCalls, 1); assert.equal(f.entries(), 0);
  });

test('an authenticated unmarked legacy reply retains its existing adoption path without added collection-source reads', async t => {
  const f = await fixture(t, false), { p, call } = await received(f);
  assert.equal((await input(f, call)).readCollections![0]!.resumeMode, undefined);
  let sourceReads = 0, inputReads = 0; const get = f.services.artifacts.get.bind(f.services.artifacts);
  f.compiler.sourcesCurrent = async () => { sourceReads++; throw new Error('unexpected_legacy_source_recheck'); };
  f.services.artifacts.get = async (ref, policy) => { if (ref.id === call.inputArtifact.id) inputReads++; return get(ref, policy); };
  assert.equal(await p.adopt('work-1', call.id), true);
  assert.equal(sourceReads, 0); assert.equal(inputReads, 1);
  const state = await f.runtime.state('work-1'); assert.equal(state.modelCalls[0]!.status, 'accepted'); assert.equal(state.budget.used.tokens, 18);
});

test('planning uses the inspected connection wait for an incomplete stored-only collection before reservation or automatic compact', async t => {
  const f = await fixture(t, false); availability(f, 'stored_only'); const p = planning(f), before = await f.runtime.state('work-1');
  assert.equal(f.runtime.control(before).kind, 'replan');
  const inspected = await f.runtime.inspectedControl(before);
  assert.equal(inspected.kind, 'wait'); assert.equal(inspected.reason, 'connection_required');
  await assert.rejects(p.reserve('work-1'), /model_not_needed/);
  assert.equal(await p.compactStep('work-1'), null);
  const after = await f.runtime.state('work-1');
  assert.deepEqual(after.modelCalls, []); assert.equal(after.budget.used.modelCalls, 0);
  assert.equal(after.budget.reservedModelCalls, 0); assert.deepEqual(after.attempts, before.attempts);
  assert.equal(f.planner.inputs.length, 0); assert.equal(f.entries(), 0);
});

test('both fixed prompts describe an exact local successor proposal and preserve strict plan/output and prompt fingerprint checks', async t => {
  const f = await fixture(t), state = await f.runtime.state('work-1'); availability(f, 'stored_only');
  const prepared = await f.compiler.prepare(state, contextOptions), requests: StructuredPlannerRequest[] = [];
  const adapter = new StructuredPlannerAdapter({ identity: { provider: 'scripted', model: 'fixture', revision: '1' }, destination: 'local',
    capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000 } }, {
    invoke: async request => {
      requests.push(request); const row = request.packet.readCollections![0]!, task = request.packet.plan!.tasks[0]!;
      return { finish: 'stop', provider: 'scripted', model: 'fixture', usage: { inputTokens: 13, outputTokens: 5 }, content: JSON.stringify({
        baseStateRevision: request.packet.stateRevision, baseGoalRevision: 1, basePlanRevision: request.packet.plan!.revision,
        reason: 'Explicit local consumption proposal', hypotheses: [], tasks: [{ ...task, id: 'resume-task', readResume: { attemptId: row.attemptId, checkpointId: row.progress.head.id } }],
      }) };
    },
  });
  const estimate = adapter.estimateInput(prepared.packet, prepared.options); assert.equal(requests.length, 0);
  const reply = await adapter.propose(prepared.packet, new AbortController().signal, prepared.options);
  assert.equal(reply.status, 'ok'); assert.equal(requests.length, 1); assert.deepEqual(requests[0]!.options.tools, []);
  assert.equal(estimate.bytes, Buffer.byteLength(JSON.stringify(requests[0])));
  const prompt = createAgentTurnPrompt({ agentId: 'agent', purpose: 'Local collection fixture', skillsMode: 'off' });
  for (const instructions of [prompt.instructions, requests[0]!.instructions]) {
    assert.match(instructions, /resumeMode stored_complete/); assert.match(instructions, /even when the source is online/);
    assert.match(instructions, /not a fresh tool call or execution permission/); assert.match(instructions, /do not infer a missing query/);
  }
  assert.equal(matchesAgentTurnPrompt(prompt, createAgentTurnPrompt(prompt.profile)), true);
  assert.equal(matchesAgentTurnPrompt({ ...prompt, instructions: `${prompt.instructions}\nchanged` }, prompt), false);
  assert.equal(matchesAgentTurnPrompt({ ...prompt, digest: '0'.repeat(64) }, prompt), false);
  assert.equal(prompt.digest, f.services.digester.digest(asJson({ version: prompt.version, instructions: prompt.instructions, profile: prompt.profile })));
  assert.equal(f.entries(), 0);
});
