import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelCallOptions, Tool } from '../application/ports.js';
import type { ContextPacket } from '../domain/model.js';
import { ContextCompiler, type ContextLimits } from '../application/context-compiler.js';
import { ContextFrameSchema } from '../application/context-contracts.js';
import { modelContextPreviewEnvelope, type ModelContextPreview } from '../application/model-context-preview.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { transact } from '../application/work-transactions.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { windowFixture } from './session-window-helpers.js';

type Fixture = Awaited<ReturnType<typeof windowFixture>>;
const broadLimits: ContextLimits = { callId: 'inspect-only', maxOutputTokens: 128, maxInputBytes: 1000000, maxInputTokens: 1000000 };
const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Explicit local measurement, with no model invocation: preview has no published session head. */
function estimator(f: Fixture) {
  const previews: { input: ModelContextPreview; options: ModelCallOptions }[] = [];
  const full: { packet: ContextPacket; options: ModelCallOptions }[] = [];
  f.planner.estimateContextPreview = (input, options) => {
    previews.push(structuredClone({ input, options })); const bytes = byteLength(modelContextPreviewEnvelope(input, options));
    return { bytes, tokens: bytes, method: 'synthetic_preview_bytes' };
  };
  f.planner.estimateInput = (packet, options) => {
    full.push(structuredClone({ packet, options })); const bytes = byteLength({ packet, options });
    return { bytes, tokens: bytes, method: 'synthetic_full_bytes' };
  };
  return { previews, full };
}

function observeWrites(f: Fixture) {
  const count = { publishHead: 0, retainHead: 0, artifactPut: 0, stateCommit: 0, normalContext: 0, prepareCompact: 0 };
  const publishHead = f.repository.publishHead.bind(f.repository), retainHead = f.repository.retainHead.bind(f.repository);
  const put = f.services.artifacts.put.bind(f.services.artifacts), commit = f.services.state.commit.bind(f.services.state);
  const context = f.sessions.context.bind(f.sessions), prepareCompact = f.sessions.prepareCompact.bind(f.sessions);
  f.repository.publishHead = async (...args) => { count.publishHead++; return publishHead(...args); };
  f.repository.retainHead = async (...args) => { count.retainHead++; return retainHead(...args); };
  f.services.artifacts.put = async (...args) => { count.artifactPut++; return put(...args); };
  f.services.state.commit = async (...args) => { count.stateCommit++; return commit(...args); };
  f.sessions.context = async (...args) => { count.normalContext++; return context(...args); };
  f.sessions.prepareCompact = async (...args) => { count.prepareCompact++; return prepareCompact(...args); };
  return count;
}
const noWrites = { publishHead: 0, retainHead: 0, artifactPut: 0, stateCommit: 0, normalContext: 0, prepareCompact: 0 };

test('inspect writes neither raw session head nor frame; materialize publishes one actual head and one frame without changing work state', async t => {
  const f = await windowFixture(t, 3), measured = estimator(f), before = await f.current(), history = await f.history();
  const sessionBefore = await f.repository.get(f.session.scope), writes = observeWrites(f);
  assert.equal(sessionBefore.head, null);
  const inspection = await f.context.inspect(before, broadLimits);
  assert.equal(inspection.kind, 'fits'); assert.deepEqual(writes, noWrites);
  assert.equal(measured.full.length, 0); assert.ok(measured.previews.length > 1);
  for (const preview of measured.previews) {
    assert.equal(Object.hasOwn(preview.input.packet, 'session'), false);
    assert.equal(Object.hasOwn(preview.input.session!, 'head'), false);
  }
  assert.deepEqual(await f.repository.get(f.session.scope), sessionBefore);
  assert.deepEqual(await f.current(), before); assert.deepEqual(await f.history(), history);
  const prepared = await f.context.materialize(inspection);
  assert.deepEqual(writes, { ...noWrites, publishHead: 1, artifactPut: 1 });
  assert.equal(measured.full.length, 1); assert.equal(prepared.estimate.method, 'synthetic_full_bytes');
  assert.deepEqual(prepared.packet.session?.entries, history.entries);
  const actualHead = (await f.repository.get(f.session.scope)).head; assert.ok(actualHead);
  assert.deepEqual(prepared.packet.session!.head, actualHead);
  assert.deepEqual(prepared.frame.basis.session!.head, actualHead);
  const frame = ContextFrameSchema.parse(JSON.parse(Buffer.from(await f.services.artifacts.get(prepared.head.artifact, before.policy)).toString('utf8')));
  assert.deepEqual(frame, prepared.frame); assert.deepEqual(await f.current(), before);
  assert.deepEqual(await f.history(), history); assert.equal(f.planner.inputs.length, 0);
  await assert.rejects(f.context.materialize(inspection), /context_preparation_unavailable/);
  assert.equal(writes.artifactPut, 1, 'materialize handles cannot stage the same preparation twice');
});

test('session storage capacity produces only a compact-needed report, never a truncated dispatchable history or a published head', async t => {
  const f = await windowFixture(t, 4, { maxContextEntries: 2, keepRecentEntries: 1 }), measured = estimator(f);
  const state = await f.current(), history = await f.history(), writes = observeWrites(f);
  const draft = await f.sessions.inspectContext(state); assert.ok(draft); assert.equal(draft.status, 'capacity');
  assert.equal(Object.hasOwn(draft, 'entries'), false); assert.equal(Object.hasOwn(draft, 'candidate'), false);
  const inspection = await f.context.inspect(state, broadLimits);
  assert.equal(inspection.kind, 'needs_session_compact'); assert.equal(inspection.selectedEstimate, null);
  assert.ok(inspection.requiredEstimate.tokens <= broadLimits.maxInputTokens); assert.deepEqual(writes, noWrites);
  assert.ok(measured.previews.length > 0);
  for (const preview of measured.previews) assert.deepEqual(preview.input.session!.entries, [draft.currentInput]);
  assert.equal(measured.full.length, 0);
  await assert.rejects(f.context.materialize(inspection), /context_preparation_unavailable/);
  assert.deepEqual(writes, noWrites); assert.equal((await f.repository.get(f.session.scope)).head, null);
  assert.deepEqual(await f.history(), history); assert.deepEqual(await f.current(), state); assert.equal(f.planner.inputs.length, 0);
});

test('a complete stored history that exceeds the model window also requests compact, retaining every history entry in the full preview', async t => {
  const f = await windowFixture(t, 6, {}, 1200), measured = estimator(f), state = await f.current(), writes = observeWrites(f);
  const all = await f.history(), probe = await f.context.inspect(state, broadLimits); assert.equal(probe.kind, 'fits');
  assert.ok(probe.selectedEstimate!.tokens > probe.requiredEstimate.tokens);
  measured.previews.length = 0;
  const inspection = await f.context.inspect(state, { ...broadLimits, maxInputTokens: probe.requiredEstimate.tokens });
  assert.equal(inspection.kind, 'needs_session_compact'); assert.ok(inspection.selectedEstimate!.tokens > probe.requiredEstimate.tokens);
  assert.ok(measured.previews.some(value => value.input.session?.entries.length === 1));
  const complete = measured.previews.find(value => value.input.session?.entries.length === all.entries.length); assert.ok(complete);
  assert.deepEqual(complete.input.session!.entries, all.entries);
  assert.ok(measured.previews.every(value => [1, all.entries.length].includes(value.input.session!.entries.length)));
  assert.deepEqual(writes, noWrites); assert.equal(measured.full.length, 0); assert.equal(f.planner.inputs.length, 0);
  await assert.rejects(f.context.materialize(inspection), /context_preparation_unavailable/);
});

for (const required of ['current_input', 'goal_and_obligation'] as const)
  test(`${required} overflow cannot be repaired by compacting earlier history and performs no head or frame publication`, async t => {
    const f = await windowFixture(t, 3, {}, required === 'current_input' ? 4500 : 700), measured = estimator(f);
    if (required === 'goal_and_obligation') await transact(f.services, f.workId, 'large-required-state', 'synthetic_required_state', {}, state => {
      state.goal.description = 'This current goal must remain in full. '.repeat(180);
      state.obligations.push({ id: 'answer-current-question', kind: 'response', reason: 'Keep this unresolved current question.',
        status: 'pending', wakeKey: 'current-question', dueAt: 120000 });
    });
    const before = await f.current(), history = await f.history(), writes = observeWrites(f);
    const first = await f.context.inspect(before, broadLimits); assert.equal(first.kind, 'fits');
    measured.previews.length = 0;
    const inspection = await f.context.inspect(before, { ...broadLimits, maxInputTokens: first.requiredEstimate.tokens - 1 });
    assert.equal(inspection.kind, 'required_overflow'); assert.equal(inspection.requiredEstimate.tokens, first.requiredEstimate.tokens);
    for (const preview of measured.previews) {
      assert.deepEqual(preview.input.packet.goal, before.goal); assert.deepEqual(preview.input.packet.obligations, before.obligations);
      assert.deepEqual(preview.input.packet.execution!.budget, before.budget);
      assert.equal(preview.input.packet.execution!.deadlineAt, before.deadlineAt);
      assert.deepEqual(preview.input.session!.entries, [history.entries.at(-1)!]);
    }
    assert.deepEqual(writes, noWrites); assert.equal(measured.full.length, 0); assert.equal(f.planner.inputs.length, 0);
    await assert.rejects(f.context.materialize(inspection), /context_preparation_unavailable/);
    assert.deepEqual(await f.current(), before); assert.deepEqual(await f.history(), history);
  });

test('a state change after inspect makes materialize refuse the stale preparation before publishing anything', async t => {
  const f = await windowFixture(t, 3); estimator(f); const writes = observeWrites(f);
  const inspection = await f.context.inspect(await f.current(), broadLimits); assert.equal(inspection.kind, 'fits');
  await transact(f.services, f.workId, 'changed-after-inspect', 'synthetic_state_change', {}, state => { state.statusReason = 'changed after preview'; });
  const afterChange = await f.current(), observed = { ...writes };
  await assert.rejects(f.context.materialize(inspection), /context_state_changed/);
  assert.deepEqual(writes, observed); assert.equal(writes.publishHead, 0); assert.equal(writes.retainHead, 0); assert.equal(writes.artifactPut, 0);
  assert.deepEqual(await f.current(), afterChange); assert.equal((await f.repository.get(f.session.scope)).head, null);
});

test('an original history source becoming unavailable after inspect refuses materialize even when work state has not changed', async t => {
  const f = await windowFixture(t, 3); estimator(f); const state = await f.current(), writes = observeWrites(f);
  const inspection = await f.context.inspect(state, broadLimits); assert.equal(inspection.kind, 'fits');
  const originalHistory = f.repository.history.bind(f.repository);
  // A source-query boundary injection, not a work update or a real SQLite deletion.
  f.repository.history = async (...args) => { const page = await originalHistory(...args);
    return { ...page, entries: page.entries.filter(entry => entry.sourceId !== 'source-0') }; };
  await assert.rejects(f.context.materialize(inspection), /session_context_changed/);
  assert.deepEqual(writes, noWrites); assert.deepEqual(await f.current(), state);
  assert.equal((await f.repository.get(f.session.scope)).head, null); assert.equal(f.planner.inputs.length, 0);
});

test('inspect and materialize preserve optional-tool selection while keeping discovery tools and the entire session', async t => {
  const f = await windowFixture(t, 2); const measured = estimator(f);
  const source = f.services.tools.find(tool => tool.definition.id === 'fixture.read')!;
  const unused: Tool[] = Array.from({ length: 20 }, (_, index) => ({
    definition: { ...source.definition, id: `fixture.optional${index}`, description: `Unused schema ${index}. ${'optional details '.repeat(300)}` },
    execute: async () => { throw new Error('unused_tool_must_not_execute'); },
  }));
  const tools = [...f.services.tools, ...unused], contracts = new ToolContracts(tools, new AjvSchemas());
  const catalogIds = ['core.catalog.search', 'core.catalog.get'];
  assert.ok(catalogIds.every(id => tools.some(tool => tool.definition.id === id)));
  await transact(f.services, f.workId, 'allow-catalog', 'synthetic_policy', {}, state => {
    state.policy.allowedTools.push(...catalogIds, ...unused.map(tool => tool.definition.id));
  });
  const compiler = new ContextCompiler({ ...f.services, tools }, contracts, f.guidance), state = await f.current(), history = await f.history();
  const writes = observeWrites(f), limits = { ...broadLimits, maxInputBytes: 18000, forceCompact: true };
  const inspection = await compiler.inspect(state, limits); assert.equal(inspection.kind, 'fits'); assert.deepEqual(writes, noWrites);
  const prepared = await compiler.materialize(inspection), visible = contracts.visible(state.policy);
  assert.ok(prepared.options.tools.length < visible.length); assert.ok(prepared.packet.contextView!.omitted.tools > 0);
  assert.ok(catalogIds.every(id => prepared.options.tools.some(tool => tool.id === id)));
  assert.deepEqual([...prepared.packet.activeToolIds].sort(), prepared.options.tools.map(tool => tool.id).sort());
  assert.deepEqual([...prepared.packet.policy.allowedTools].sort(), [...prepared.packet.activeToolIds].sort());
  assert.deepEqual(prepared.packet.session!.entries, history.entries); assert.deepEqual(await f.current(), state);
  assert.ok(prepared.estimate.bytes <= limits.maxInputBytes); assert.equal(measured.full.length, 1); assert.equal(f.planner.inputs.length, 0);
  assert.deepEqual(writes, { ...noWrites, publishHead: 1, artifactPut: 1 });
});
