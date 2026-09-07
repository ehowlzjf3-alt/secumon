import test from 'node:test';
import assert from 'node:assert/strict';
import { modelContextPreviewEnvelope } from '../application/model-context-preview.js';
import { windowActor, windowFixture, windowText } from './session-window-helpers.js';

type Fixture = Awaited<ReturnType<typeof windowFixture>>;
const limits = { callId: 'cached-inspection', maxOutputTokens: 128, maxInputTokens: 1_000_000, maxInputBytes: 1_000_000 };
function estimate(f: Fixture) {
  f.planner.estimateContextPreview = (preview, options) => {
    const bytes = Buffer.byteLength(JSON.stringify(modelContextPreviewEnvelope(preview, options)));
    return { tokens: bytes, bytes, method: 'synthetic_preview' };
  };
  f.planner.estimateInput = (packet, options) => {
    const bytes = Buffer.byteLength(JSON.stringify({ packet, options })); return { tokens: bytes, bytes, method: 'synthetic_actual' };
  };
}
async function publishPeerSummary(f: Fixture) {
  const state = await f.current();
  const peer = await f.sessions.accept(windowActor, { sessionId: f.session.scope.sessionId, rawText: windowText(99), request: {
    messageId: 'peer-request', goal: state.goal, policy: state.policy, completionRequiresDelivery: false, limits: state.budget.limits,
    binding: { ...windowActor, channel: 'test', conversationId: 'window', recipientId: windowActor.principalId, destination: 'local' },
  } });
  assert.notEqual(peer.workId, f.workId);
  const call = await f.compactPlanning!.requestCompact(peer.workId, { force: true, requestId: 'peer-summary' }); assert.ok(call);
  await f.compactPlanning!.execute(peer.workId, call.id); assert.equal(await f.compactPlanning!.adopt(peer.workId, call.id), true);
  assert.equal(f.planner.inputs.length, 1); assert.ok(f.planner.inputs[0]!.prefix.throughSequence < state.conversation!.session!.input.sequence);
  assert.deepEqual(await f.current(), state, 'the peer did not change this work revision or applied input');
}

for (const timing of ['before_materialize', 'inside_materialize'] as const)
  test(`an accepted peer summary ${timing} requests one transient reprepare without discarding the same input`, async t => {
    const f = await windowFixture(t, 4, { maxCompactEntries: 2, keepRecentEntries: 1 }); estimate(f);
    const before = await f.current(), draft = await f.sessions.inspectContext(before); assert.ok(draft); assert.equal(draft.summary, null);
    const inspected = await f.context.inspect(before, limits); assert.equal(inspected.kind, 'fits');
    const originalMaterialize = f.sessions.materializeContext.bind(f.sessions);
    if (timing === 'before_materialize') await publishPeerSummary(f);
    else f.sessions.materializeContext = async (state, selected) => {
      f.sessions.materializeContext = originalMaterialize;
      await publishPeerSummary(f); return originalMaterialize(state, selected);
    };
    const originalInspect = f.sessions.inspectContext.bind(f.sessions); let rechecks = 0;
    f.sessions.inspectContext = async (...args) => { rechecks++; return originalInspect(...args); };
    await assert.rejects(f.context.materialize(inspected), error => error instanceof Error && error.message === 'context_state_changed' &&
      error.cause instanceof Error && error.cause.message === 'session_context_changed');
    assert.equal(rechecks, 1, 'the compiler performs one bounded classification read, not a local retry loop');
    f.sessions.inspectContext = originalInspect;
    assert.equal((await f.repository.get(f.session.scope)).head, null, 'the stale preparation did not publish a session context head');
    assert.deepEqual(await f.current(), before);
    await assert.rejects(f.context.materialize(inspected), /context_preparation_unavailable/);
    const nextDraft = await f.sessions.inspectContext(before); assert.ok(nextDraft?.summary);
    assert.deepEqual(nextDraft.basis, draft.basis); assert.deepEqual(nextDraft.currentInput, draft.currentInput); assert.deepEqual(nextDraft.sourceManifest, draft.sourceManifest);
    const next = await f.context.inspect(before, { ...limits, callId: 'fresh-inspection' }); assert.equal(next.kind, 'fits');
    const prepared = await f.context.materialize(next); assert.equal(prepared.packet.session?.schemaVersion, 2);
    if (prepared.packet.session?.schemaVersion === 2) assert.deepEqual(prepared.packet.session.summary.ref, nextDraft.summary.ref);
    assert.equal(prepared.packet.session!.entries.at(-1)!.text, draft.currentInput.text); assert.equal(f.planner.inputs.length, 1);
  });

test('a peer summary does not turn a missing original into a transient summary-only change', async t => {
  const f = await windowFixture(t, 4, { maxCompactEntries: 2, keepRecentEntries: 1 }); estimate(f);
  const state = await f.current(), inspected = await f.context.inspect(state, limits); assert.equal(inspected.kind, 'fits');
  await publishPeerSummary(f);
  const history = f.repository.history.bind(f.repository);
  f.repository.history = async (...args) => { const page = await history(...args); return { ...page, entries: page.entries.filter(entry => entry.sourceId !== 'source-0') }; };
  const inspect = f.sessions.inspectContext.bind(f.sessions); let reads = 0;
  f.sessions.inspectContext = async (...args) => { reads++; return inspect(...args); };
  await assert.rejects(f.context.materialize(inspected), error => error instanceof Error && error.message === 'session_context_changed');
  assert.equal(reads, 1); assert.deepEqual(await f.current(), state); assert.equal((await f.repository.get(f.session.scope)).head, null);
  assert.equal(f.planner.inputs.length, 1);
});
