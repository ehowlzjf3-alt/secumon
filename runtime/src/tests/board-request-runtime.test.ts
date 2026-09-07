import test from 'node:test';
import assert from 'node:assert/strict';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { BOARD_REQUEST_TOOLS, BOARD_WRITE_TOOLS } from '../application/board-commands.js';
import { buildModelContextPacket } from '../application/context-packet.js';
import { completionProofsCurrent } from '../application/completion-proofs.js';
import type { WorkState } from '../domain/model.js';
import { boardRequestFixture as fixture } from './helpers/board-request-fixture.js';

const bound = (state: WorkState) => state.obligations.filter(value => value.source);

for (const adapter of ['sqlite', 'file-journal'] as const) {
  for (const family of ['documents', 'observations']) test(`${adapter}/${family}: two runtimes request, accept, answer and confirm without treating discussion as goal completion`, async t => {
    const h = await fixture(t, adapter, family), offered = await h.offer();
    assert.equal(bound(offered.state)[0]!.mode, 'waiting'); assert.equal(bound((await h.state.get('work-b'))!).length, 0);
    const before = (await h.state.get('work-a'))!.budget.used;
    for (let i = 0; i < 3; i++) assert.equal((await h.bundle('a').runtime.step('work-a')).kind, 'wait');
    assert.deepEqual((await h.state.get('work-a'))!.budget.used, before);
    const accepted = await h.accept(); assert.equal(bound(accepted.state)[0]!.mode, 'actionable');
    await h.answer(); const requester = await h.refresh('a');
    assert.equal(bound(requester)[0]!.status, 'pending'); assert.equal(bound(requester)[0]!.mode, 'actionable');
    assert.equal(bound(await h.refresh('b'))[0]!.mode, 'waiting');
    assert.notEqual((await h.bundle('a').runtime.step('work-a')).kind, 'complete');
    await h.confirm(); const first = await h.refresh('a'), second = await h.refresh('b');
    assert.equal(bound(first)[0]!.status, 'satisfied'); assert.equal(bound(second)[0]!.status, 'satisfied');
    assert.equal(first.evidence.length, 1); assert.equal(second.evidence.length, 1);
    assert.equal(first.budget.used.modelCalls + second.budget.used.modelCalls, 0);
    assert.equal(first.budget.used.toolCalls + second.budget.used.toolCalls, 8);
    assert.notEqual((await h.bundle('a').runtime.step('work-a')).kind, 'complete');
    const frame = await h.bundle('a').context.prepare(await h.refresh('a'), { callId: 'compact', maxInputBytes: 500000, maxInputTokens: 600000, maxOutputTokens: 1000, forceCompact: true });
    assert.equal(frame.packet.obligations.find(value => value.source)?.source?.externalId, 'request');
    await h.reopen(); const restored = await h.bundle('a').recovery.restore('work-a', h.actors['a']!);
    assert.equal(restored.packet.context.obligations.find(value => value.source)?.status, 'satisfied');
    assert.equal((await h.refresh('a')).revision, (await h.refresh('a')).revision, 'unchanged refresh is a no-op');
  });
  test(`${adapter}: lost offer response restores one obligation from the applied receipt without inventing a result`, async t => {
    const h = await fixture(t, adapter); await h.publish('a', 'question');
    const input = { ...await h.mutation(), id: 'request', questionId: 'question', toAgentId: 'role-b', deliverable: 'Cited answer', dueAt: 50000 };
    const pending = await h.prepare('a', BOARD_REQUEST_TOOLS[0], input), bundle = h.bundle('a');
    await bundle.runtime.dispatch('work-a', pending.attempt.id);
    const result = await bundle.services.tools.find(value => value.definition.id === pending.task.toolId)!.execute(pending.task,
      { workId: 'work-a', attemptId: pending.attempt.id, policy: (await h.state.get('work-a'))!.policy, signal: new AbortController().signal });
    assert.equal(result.status, 'success'); assert.equal(bound((await h.state.get('work-a'))!).length, 0);
    h.clock.advance(20000); await h.reopen(); const recovered = await h.bundle('a').runtime.recover('work-a', pending.attempt.id);
    assert.equal(bound(recovered).length, 1); assert.equal(bound(recovered)[0]!.status, 'pending');
    const attempt = recovered.attempts.find(value => value.id === pending.attempt.id)!;
    assert.equal(attempt.resultArtifact, null); assert.equal(attempt.adopted, false); assert.equal(attempt.effectReceipt?.origin, 'reconciliation');
    await h.bundle('a').runtime.receive('work-a', attempt.id, result); await h.refresh('a');
    assert.equal(bound((await h.state.get('work-a'))!).length, 1); assert.equal((await h.repository.get('tenant-a', 'board'))!.requests.length, 1);
  });
  test(`${adapter}: a missing projection is restored and generic wait or resolve cannot forge coordination`, async t => {
    const h = await fixture(t, adapter), offered = await h.offer(), obligation = bound(offered.state)[0]!;
    await assert.rejects(h.bundle('a').runtime.command('work-a', 'resolve-forged', h.actors['a']!, 1, { kind: 'resolve', obligationId: obligation.id, reason: 'pretend completed' }), /obligation_not_resolvable/);
    await assert.rejects(h.bundle('a').runtime.command('work-a', 'wait-forged', h.actors['a']!, 1, { kind: 'wait', obligation: { ...obligation, id: 'forged' } }), /invalid_wait_obligation/);
    await h.edit('a', state => { state.obligations = []; }); const missing = (await h.state.get('work-a'))!;
    assert.equal(await completionProofsCurrent(h.bundle('a').services, missing), false);
    await assert.rejects(buildModelContextPacket(missing, h.bundle('a').contracts, h.bundle('a').services));
    assert.equal(bound(await h.refresh('a')).length, 1);
    assert.equal(await completionProofsCurrent({ effects: h.bundle('a').services.effects }, await h.refresh('a')), false);
    const packet = await buildModelContextPacket(await h.refresh('a'), h.bundle('a').contracts, h.bundle('a').services); packet.obligations = [];
    assert.equal(await h.bundle('a').context.sourcesCurrent(packet, await h.refresh('a')), false);
  });
  test(`${adapter}: requester can cancel a waiting request and cancellation is waived rather than satisfied`, async t => {
    const h = await fixture(t, adapter); await h.offer(); await h.accept();
    await h.execute('a', BOARD_REQUEST_TOOLS[5], { ...await h.mutation(), requestId: 'request' });
    assert.equal(bound(await h.refresh('a'))[0]!.status, 'waived'); assert.equal(bound(await h.refresh('b'))[0]!.status, 'waived');
  });
  test(`${adapter}: decline does not create an obligation for a recipient who never accepted`, async t => {
    const h = await fixture(t, adapter); await h.offer();
    await h.execute('b', BOARD_REQUEST_TOOLS[4], { ...await h.mutation(), requestId: 'request' });
    assert.equal(bound(await h.refresh('b')).length, 0); assert.equal(bound(await h.refresh('a'))[0]!.status, 'waived');
  });
  test(`${adapter}: expiry is actionable review and retains the original pending obligation`, async t => {
    const h = await fixture(t, adapter); await h.offer(); h.clock.advance(50000);
    const current = await h.refresh('a'); assert.equal(bound(current)[0]!.status, 'pending'); assert.equal(bound(current)[0]!.mode, 'actionable');
    assert.match(bound(current)[0]!.reason, /expired/);
    await h.execute('a', BOARD_REQUEST_TOOLS[5], { ...await h.mutation(), requestId: 'request' });
    assert.equal(bound(await h.refresh('a'))[0]!.status, 'waived');
  });
  test(`${adapter}: confirmed answer retraction invalidates the previous completion projection`, async t => {
    const h = await fixture(t, adapter); await h.offer(); await h.accept(); await h.answer(); await h.confirm();
    const prior = await h.refresh('a'); assert.equal(bound(prior)[0]!.status, 'satisfied');
    await assert.rejects(h.execute('b', BOARD_WRITE_TOOLS[1], { ...await h.mutation(), postId: 'answer' }), /board_command_unavailable/);
    assert.equal((await h.repository.get('tenant-a', 'board'))!.posts.find(value => value.id === 'answer')!.status, 'retracted');
    assert.equal(await completionProofsCurrent(h.bundle('a').services, prior), false);
    const current = await h.bundle('a').services.obligations!.refresh('work-a');
    assert.equal(bound(current)[0]!.status, 'pending'); assert.equal(bound(current)[0]!.mode, 'actionable');
  });
  test(`${adapter}: loss of an applied request receipt cannot silently discharge the response`, async t => {
    const h = await fixture(t, adapter), offered = await h.offer();
    await unlink(join(h.directory, 'artifacts', `${offered.attempt.effectReceipt!.artifact.id}.blob`));
    assert.equal(await completionProofsCurrent(h.bundle('a').services, offered.state), false);
    await assert.rejects(h.refresh('a'));
    assert.equal(bound((await h.state.get('work-a'))!)[0]!.status, 'pending');
  });
  test(`${adapter}: lost acceptance response recovers the assignee obligation and leaves work executable`, async t => {
    const h = await fixture(t, adapter); await h.offer(); await h.read('b');
    const pending = await h.prepare('b', BOARD_REQUEST_TOOLS[1], { ...await h.mutation(), requestId: 'request' });
    const bundle = h.bundle('b'); await bundle.runtime.dispatch('work-b', pending.attempt.id);
    const result = await bundle.services.tools.find(value => value.definition.id === pending.task.toolId)!.execute(pending.task,
      { workId: 'work-b', attemptId: pending.attempt.id, policy: (await h.state.get('work-b'))!.policy, signal: new AbortController().signal });
    assert.equal(result.status, 'success'); h.clock.advance(20000); await h.reopen();
    const recovered = await h.bundle('b').runtime.recover('work-b', pending.attempt.id);
    assert.equal(bound(recovered).length, 1); assert.equal(bound(recovered)[0]!.mode, 'actionable');
    assert.equal(recovered.attempts.at(-1)!.resultArtifact, null);
    await h.answer(); assert.equal(bound(await h.refresh('b'))[0]!.mode, 'waiting');
  });
  test(`${adapter}: an expired assignee can decline instead of falsely satisfying the answer`, async t => {
    const h = await fixture(t, adapter); await h.offer(); await h.accept(); h.clock.advance(50000);
    await h.execute('b', BOARD_REQUEST_TOOLS[4], { ...await h.mutation(), requestId: 'request' });
    assert.equal(bound(await h.refresh('b'))[0]!.status, 'waived'); assert.equal(bound(await h.refresh('a'))[0]!.status, 'waived');
  });
  test(`${adapter}: coordination waits do not become questions for a human`, async t => {
    const h = await fixture(t, adapter); await h.offer();
    const snapshot = await h.bundle('a').conversation.snapshot('work-a', h.actors['a']!);
    assert.deepEqual(snapshot.pendingQuestions, []); assert.equal(snapshot.analysisReady, false);
  });
  test(`${adapter}: withdrawal of current authority denies a retained coordination projection`, async t => {
    const h = await fixture(t, adapter), offered = await h.offer(); h.actors['a']!.allowedNamespaces = [];
    assert.equal(await completionProofsCurrent(h.bundle('a').services, offered.state), false);
    await assert.rejects(h.bundle('a').recovery.restore('work-a', h.actors['a']!));
  });
  test(`${adapter}: request tool contracts reject caller-selected owner, command and action`, async t => {
    const h = await fixture(t, adapter); await h.offer(); await h.read('b');
    for (const extra of [{ workId: 'work-a' }, { commandId: 'reuse-command' }, { action: 'confirm' }, { actor: { canPublish: true } }])
      await assert.rejects(h.prepare('b', BOARD_REQUEST_TOOLS[1], { ...await h.mutation(), requestId: 'request', ...extra }));
  });
  test(`${adapter}: even satisfied goal facts wait for requester confirmation`, async t => {
    const h = await fixture(t, adapter); await h.offer();
    await h.edit('a', state => { state.evidence[0]!.facts['available'] = true; });
    assert.equal((await h.bundle('a').runtime.step('work-a')).kind, 'wait');
    await h.accept(); await h.answer();
    assert.notEqual((await h.bundle('a').runtime.step('work-a')).kind, 'complete');
    await h.confirm(); assert.equal((await h.bundle('a').runtime.step('work-a')).kind, 'complete');
  });
}
