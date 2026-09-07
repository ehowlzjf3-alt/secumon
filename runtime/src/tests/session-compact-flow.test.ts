import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import type { SessionScope } from '../domain/session.js';
import { actor, request, initialize, openCompact, compactOnce, compactUsage, longText, preservation, preparedSession, seedCompletedXAndActiveY } from './session-compact-flow-helpers.js';

function directory(backend: 'sqlite' | 'file-journal') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'session-compact-flow-'))); mkdirSync(join(base, 'engine'), { mode: 0o700 }); initialize(base, backend); return base;
}

for (const backend of ['sqlite', 'file-journal'] as const) test(`${backend}: completed X, three compacts in Y, and reopened Z retain quotes and independent work ledgers`, { timeout: 60000 }, async () => {
  const base = directory(backend); let f = await openCompact(base);
  try {
    const { session, x, y } = await seedCompletedXAndActiveY(f); const scope = session.scope;
    const xBefore = await f.runtime.state(x.workId); assert.equal(xBefore.budget.used.toolCalls, 1); assert.equal(xBefore.budget.used.modelCalls, 0);
    const summaries = [];
    for (let round = 1; round <= 3; round++) {
      if (round > 1) await f.sessions!.input(actor, { sessionId: scope.sessionId, workId: y.workId, messageId: `y-${round}`,
        rawText: longText(round === 2 ? preservation[3].quote : '다음 작업에도 앞서 정한 형식과 미해결 질문을 유지해 줘.'), expectedGoalRevision: 1 });
      const originals = await f.stores.sessions.history(scope, request('y').policy, { limit: 256 });
      const compact = await compactOnce(f, y.workId, `compact-${round}`); summaries.push(compact.summary);
      assert.equal(compact.call.purpose, 'session_compact'); assert.equal(compact.state.modelCalls.find(call => call.id === compact.call.id)?.status, 'accepted');
      assert.deepEqual(await f.stores.sessions.history(scope, request('y').policy, { limit: 256 }), originals, 'compact never deletes or rewrites transcript originals');
      const { prepared } = await preparedSession(f, y.workId, `inspect-y-${round}`); const context = prepared.packet.session!;
      assert.equal(context.schemaVersion, 2); if (context.schemaVersion !== 2) throw new Error('missing_summary_context');
      assert.equal(context.summary.ref.id, compact.summary.ref.id);
      assert.ok(context.summary.ref.throughSequence < context.basis.input.sequence);
      assert.equal(context.entries.at(-1)?.sourceId, round === 1 ? 'y' : `y-${round}`);
      assert.equal(prepared.frame.metrics.extraModelCalls, 0, 'context compilation itself does not hide another model call');
      assert.equal(compact.state.budget.used.tokens, round * (compactUsage.inputTokens + compactUsage.outputTokens));
      assert.equal(compact.state.budget.reservedTokens, 0); assert.equal(compact.state.budget.reservedModelCalls, 0);
    }
    assert.ok(summaries[0]!.ref.throughSequence < summaries[1]!.ref.throughSequence && summaries[1]!.ref.throughSequence < summaries[2]!.ref.throughSequence);
    assert.equal(summaries[1]!.previous?.id, summaries[0]!.ref.id); assert.equal(summaries[2]!.previous?.id, summaries[1]!.ref.id);
    const finalSummary = summaries[2]!;
    assert.deepEqual(finalSummary.content.retained.map(item => item.id), preservation.map(item => item.id));
    const transcript = await f.stores.sessions.history(scope, request('y').policy, { limit: 256 });
    for (const item of finalSummary.content.retained) {
      assert.equal(item.status, 'active');
      for (const quote of item.citations) assert.ok(transcript.entries.some(entry => entry.sequence === quote.sequence && entry.sourceId === quote.sourceId && entry.role === quote.role && entry.text.includes(quote.quote)));
    }
    const yBefore = await f.runtime.state(y.workId); assert.equal(yBefore.budget.used.modelCalls, 3); assert.equal(yBefore.budget.used.toolCalls, 0);
    assert.deepEqual(yBefore.evidence, []); assert.deepEqual(yBefore.attempts, []); assert.equal(yBefore.plan, null);
    assert.equal(f.planner.inputs.length, 3); assert.equal(f.planner.planCalls, 0); assert.equal(f.tool.invocations.length, 1);
    assert.deepEqual(await f.runtime.state(x.workId), xBefore, 'Y compact does not mutate completed X or its resource account');
    await f.close(); f = await openCompact(base);
    const reopened = await f.sessions!.open(actor, { channel: 'test', conversationId: 'conversation' }); assert.deepEqual(reopened.scope, scope);
    assert.deepEqual(await f.stores.sessions.history(scope, request('y').policy, { limit: 256 }), transcript);
    assert.deepEqual(await f.runtime.state(y.workId), yBefore); assert.deepEqual(await f.runtime.state(x.workId), xBefore);
    const latest = 'Z의 새 문서를 검토하되 이전의 미해결 질문을 확정 답으로 바꾸지 마.';
    const z = await f.sessions!.accept(actor, { sessionId: scope.sessionId, rawText: latest, request: request('z') });
    assert.notEqual(z.workId, x.workId); assert.notEqual(z.workId, y.workId);
    const { prepared, artifact, state } = await preparedSession(f, z.workId, 'inspect-z'); const context = prepared.packet.session!;
    assert.equal(context.schemaVersion, 2); if (context.schemaVersion !== 2) throw new Error('missing_summary_context');
    assert.deepEqual(context.summary, { ref: finalSummary.ref, content: finalSummary.content });
    assert.equal(context.entries.at(-1)?.text, latest); assert.equal(context.entries.at(-1)?.workId, z.workId);
    assert.ok(context.entries.every(entry => entry.sequence > finalSummary.ref.throughSequence));
    assert.deepEqual(artifact.packet.session, context); assert.equal(context.interpretation, 'conversation_history_not_verified_evidence');
    assert.equal(state.budget.used.tokens, 0); assert.equal(state.budget.used.modelCalls, 0); assert.equal(state.budget.used.toolCalls, 0);
    assert.deepEqual(state.evidence, []); assert.deepEqual(state.attempts, []); assert.equal(state.plan, null);
    assert.equal(f.planner.inputs.length, 0, 'reopen and next context reuse stored summaries without another provider call');
    assert.equal((await f.runtime.state(y.workId)).budget.used.tokens, 3 * (compactUsage.inputTokens + compactUsage.outputTokens));
  } finally { await f.close(); rmSync(base, { recursive: true, force: true }); }
});

interface Checkpoint { checkpoint: 'reply' | 'publication'; workId: string; callId: string; scope: SessionScope }
for (const backend of ['sqlite', 'file-journal'] as const) for (const phase of ['reply', 'publication'] as const)
  test(`${backend}: SIGKILL after compact ${phase} reuses stored response and preserves one usage settlement`, { timeout: 60000 }, async () => {
    const base = directory(backend);
    const child = fork(new URL('./helpers/session-compact-flow-worker.js', import.meta.url), [base, phase], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = ''; child.stderr!.on('data', data => { output += data.toString(); }); child.stdout!.on('data', data => { output += data.toString(); });
    const exit = once(child, 'exit');
    try {
      const checkpoint = await new Promise<Checkpoint>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`compact checkpoint timeout: ${output}`)), 45000);
        child.once('message', value => { clearTimeout(timer); const message = value as Checkpoint;
          try { assert.equal(message.checkpoint, phase); assert.ok(message.workId && message.callId && message.scope?.sessionId); resolve(message); } catch (error) { reject(error); } });
        child.once('exit', () => { clearTimeout(timer); reject(new Error(`compact checkpoint missing: ${output}`)); }); child.once('error', reject);
      });
      child.kill('SIGKILL'); const [code, signal] = await exit; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
      const f = await openCompact(base);
      try {
        const before = await f.runtime.state(checkpoint.workId); const call = before.modelCalls.find(item => item.id === checkpoint.callId)!;
        assert.equal(call.status, 'received'); assert.ok(call.replyArtifact); assert.equal(await f.stores.artifacts.exists(call.replyArtifact), true);
        const reply = JSON.parse(Buffer.from(await f.stores.artifacts.get(call.replyArtifact, before.policy)).toString()); assert.equal(reply.status, 'ok');
        assert.equal(before.budget.used.modelCalls, 1); assert.equal(before.budget.used.tokens, compactUsage.inputTokens + compactUsage.outputTokens);
        const original = await f.stores.sessions.history(checkpoint.scope, before.policy, { limit: 256 });
        const published = await f.stores.sessions.publication(checkpoint.scope, call.id); assert.equal(published !== null, phase === 'publication');
        if (phase === 'publication') f.services.clock.now = () => Date.now() + 130000;
        f.planner.compact = async () => { throw new Error('unexpected_duplicate_compact_provider_call'); };
        assert.equal(await f.compactPlanning!.adopt(checkpoint.workId, call.id), true);
        assert.equal(await f.compactPlanning!.adopt(checkpoint.workId, call.id), true);
        const after = await f.runtime.state(checkpoint.workId); assert.equal(after.modelCalls.length, 1); assert.equal(after.modelCalls[0]?.status, 'accepted');
        assert.deepEqual(after.budget.used, before.budget.used); assert.equal(after.budget.reservedTokens, 0); assert.equal(after.budget.reservedModelCalls, 0);
        assert.equal(f.planner.inputs.length, 0); assert.deepEqual(await f.stores.sessions.history(checkpoint.scope, before.policy, { limit: 256 }), original);
        const receipt = await f.stores.sessions.publication(checkpoint.scope, call.id); assert.ok(receipt); if (published) assert.deepEqual(receipt, published);
        const { prepared } = await preparedSession(f, checkpoint.workId, 'after-real-kill'); const context = prepared.packet.session!;
        assert.equal(context.schemaVersion, 2); if (context.schemaVersion !== 2) throw new Error('missing_summary_context');
        assert.equal(context.summary.ref.id, receipt.ref.id); assert.equal(context.entries.at(-1)?.sourceId, 'y');
        assert.ok(context.summary.ref.throughSequence < context.basis.input.sequence);
      } finally { await f.close(); }
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
      rmSync(base, { recursive: true, force: true });
    }
  });
