import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CommitRequest, CommitResult, StateRepository } from '../application/ports.js';
import type { WorkState } from '../domain/model.js';
import { adapters, advance, attempt, command, delivery, initial, modelCall, openRepository, snapshot, type Adapter, type WorkerRequest } from './state-conformance-helpers.js';

async function withRepository(adapter: Adapter, run: (store: StateRepository, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), `state-conformance-${adapter}-`));
  const store = openRepository(adapter, directory);
  try { await run(store, directory); }
  finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
}
function mutateSnapshot(change: () => void) {
  try { change(); } catch (error) { if (!(error instanceof TypeError)) throw error; }
}
async function worker(adapter: Adapter, directory: string) {
  const child = fork(new URL('./state-conformance-worker.js', import.meta.url), [adapter, directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
  const exit = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  const dispose = () => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
  try {
    const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(10000) });
    assert.equal(ready.type, 'ready', stderr);
  } catch (error) { dispose(); throw error; }
  return {
    async request(request: WorkerRequest) {
      const response = once(child, 'message', { signal: AbortSignal.timeout(10000) });
      child.send(request);
      const [[message], [code, signal]] = await Promise.all([response, exit]);
      assert.equal(message.type, 'result', `${stderr}\n${JSON.stringify(message)}`);
      if (request.operation === 'commit' && request.crashAfterCommit) assert.equal(signal, 'SIGKILL', stderr);
      else assert.equal(code, 0, stderr);
      return message.result as unknown;
    }, dispose,
  };
}

for (const adapter of adapters) {
  test(`${adapter}: one commit and reopen retain state, all ordered events, deliveries and historical receipts`, async () => {
    await withRepository(adapter, async (store, directory) => {
      const first = command(initial(), 'accept', [delivery(), { ...delivery('work-1', 'question'), kind: 'question' }]);
      first.events.push({ type: 'accepted', at: 1000, data: { nested: { ids: ['original'] } } });
      assert.equal((await store.commit(first)).kind, 'committed');
      const second = command(advance(first.next, 'waiting'), 'wait', [{ ...delivery(), status: 'delivered', externalId: 'receiver-ack' }]);
      second.next.status = 'waiting'; second.next.obligations.push({ id: 'reply', kind: 'response', reason: 'Wait for reply', status: 'pending', wakeKey: 'reply', dueAt: 2000 });
      assert.equal((await store.commit(second)).kind, 'committed');
      const expected = await snapshot(store, first.workId, ['accept', 'wait']);
      assert.deepEqual(expected.state, second.next);
      assert.deepEqual(expected.events.map(e => [e.sequence, e.revision, e.commandId, e.type]), [[1, 1, 'accept', 'state_changed'], [2, 1, 'accept', 'accepted'], [3, 2, 'wait', 'state_changed']]);
      assert.deepEqual(expected.deliveries, [{ ...delivery(), status: 'delivered', externalId: 'receiver-ack' }, { ...delivery('work-1', 'question'), kind: 'question' }]);
      assert.deepEqual(expected.receipts, { accept: { digest: first.commandDigest, state: first.next }, wait: { digest: second.commandDigest, state: second.next } });
      const reopened = openRepository(adapter, directory);
      try { assert.deepEqual(await snapshot(reopened, first.workId, ['accept', 'wait']), expected); }
      finally { await reopened.close(); }
    });
  });

  test(`${adapter}: duplicate and idempotency conflict precede revision conflict and preserve the first receipt`, async () => {
    await withRepository(adapter, async store => {
      const accepted = command(initial(), 'accept', [delivery()]); await store.commit(accepted);
      const later = command(advance(accepted.next), 'later'); await store.commit(later);
      const before = await snapshot(store, accepted.workId, ['accept', 'later', 'stale']);
      assert.deepEqual(await store.commit(accepted), { kind: 'duplicate', state: accepted.next });
      const retryWithNewRevision = command(advance(later.next), 'accept', [{ ...delivery(), text: 'Must not overwrite original' }]);
      assert.deepEqual(await store.commit(retryWithNewRevision), { kind: 'duplicate', state: accepted.next });
      assert.deepEqual(await store.commit({ ...accepted, commandDigest: 'different' }), { kind: 'idempotency_conflict' });
      assert.deepEqual(await store.commit({ ...accepted, commandId: 'stale', commandDigest: 'digest:stale' }), { kind: 'conflict', actualRevision: 2 });
      assert.deepEqual(await snapshot(store, accepted.workId, ['accept', 'later', 'stale']), before);
    });
  });

  test(`${adapter}: malformed commits leave all four collections unchanged, even on duplicate commands`, async () => {
    await withRepository(adapter, async store => {
      const first = command(initial(), 'accept', [delivery()]); await store.commit(first);
      const before = await snapshot(store, first.workId, ['accept', 'invalid']);
      const valid = command(advance(first.next), 'invalid', [{ ...delivery(), status: 'delivered' }]);
      const malformed: CommitRequest[] = [
        { ...valid, workId: 'other-work' }, { ...valid, next: { ...valid.next, revision: 9 } },
        { ...valid, events: [] }, { ...valid, next: { ...valid.next, updatedAt: 0 } },
        { ...valid, deliveries: [delivery('other-work')] }, { ...valid, deliveries: [delivery(), delivery()] },
        { ...first, events: [] },
      ];
      for (const request of malformed) {
        await assert.rejects(store.commit(request), /invalid_commit|invalid_contract/);
        assert.deepEqual(await snapshot(store, first.workId, ['accept', 'invalid']), before);
        assert.equal(await store.get('other-work'), null);
      }
      assert.equal((await store.commit(valid)).kind, 'committed');
    });
  });

  test(`${adapter}: caller mutations and mutable returned snapshots cannot rewrite persisted history`, async () => {
    await withRepository(adapter, async (store, directory) => {
      const request = command(initial(), 'accept', [delivery()]);
      request.events[0]!.data['nested'] = { values: ['original'] };
      const original = structuredClone(request);
      const pending = store.commit(request);
      request.next.goal.description = 'Caller mutation'; request.next.policy.allowedLabels.push('unexpected');
      request.events[0]!.data['nested'] = 'Caller mutation'; request.deliveries[0]!.text = 'Caller mutation';
      const committed = await pending; assert.equal(committed.kind, 'committed');
      const old = (await store.get(request.workId))!;
      if (committed.kind === 'committed') mutateSnapshot(() => { committed.state.goal.description = 'Returned commit mutation'; });
      const receipt = (await store.receipt(original.workId, 'accept'))!;
      mutateSnapshot(() => { receipt.state.policy.allowedLabels.push('unexpected'); });
      const events = await store.events(original.workId, 0);
      mutateSnapshot(() => { events[0]!.data['nested'] = 'Returned event mutation'; });
      const deliveries = await store.deliveries(original.workId);
      mutateSnapshot(() => { deliveries[0]!.text = 'Returned delivery mutation'; });
      assert.deepEqual(await store.get(original.workId), original.next);
      assert.deepEqual((await store.receipt(original.workId, 'accept'))!.state, original.next);
      assert.deepEqual((await store.events(original.workId, 0))[0]!.data, original.events[0]!.data);
      assert.deepEqual(await store.deliveries(original.workId), original.deliveries);
      const next = advance(original.next); await store.commit(command(next, 'advance'));
      assert.deepEqual(old, original.next);
      mutateSnapshot(() => { old.goal.criteria[0]!.description = 'Old get mutation'; });
      const reopened = openRepository(adapter, directory);
      try { assert.deepEqual(await reopened.get(original.workId), next); assert.deepEqual((await reopened.receipt(original.workId, 'accept'))!.state, original.next); }
      finally { await reopened.close(); }
    });
  });

  test(`${adapter}: work, tenant, principal, channel and conversation identifiers remain separate`, async () => {
    await withRepository(adapter, async store => {
      const cases = [
        ['work-a', 'tenant-a', 'person-a', 'test', 'chat'], ['work-b', 'tenant-b', 'person-a', 'test', 'chat'],
        ['work-c', 'tenant-a', 'person-b', 'test', 'chat'], ['work-d', 'tenant-a', 'person-a', 'test', 'other-chat'],
        ['work-e', 'tenant-a', 'person-a', 'knox', 'chat'], ['work-f', 'tenant-a', 'person-a', 'test', 'chat'],
      ] as const;
      for (const [id, tenantId, principalId, channel, conversationId] of cases) {
        const state = initial(id); state.policy.tenantId = tenantId; state.policy.principalId = principalId;
        const binding = { id: 'binding', channel, conversationId, recipientId: principalId, destination: 'local', tenantId, principalId };
        state.conversation = { bindings: [binding], primaryBindingId: binding.id, completionRequiresDelivery: true, result: null };
        if (id === 'work-f') state.conversation.bindings[0]!.tenantId = 'tenant-b';
        await store.commit(command(state, 'same-command', [delivery(id, 'same-delivery')]));
      }
      for (const [id, tenantId, principalId, channel, conversationId] of cases.slice(0, 5)) {
        assert.deepEqual(await store.workIdsForConversation(tenantId, principalId, channel, conversationId), [id]);
        assert.equal((await store.receipt(id, 'same-command'))!.state.id, id);
        assert.deepEqual((await store.events(id, 0)).map(e => [e.workId, e.sequence]), [[id, 1]]);
        assert.deepEqual((await store.deliveries(id)).map(d => d.workId), [id]);
      }
      assert.deepEqual(await store.workIdsForConversation('tenant-b', 'person-a', 'test', 'chat'), ['work-b']);
      assert.deepEqual(await store.workIdsForConversation('missing', 'person-a', 'test', 'chat'), []);
      assert.equal(await store.get('missing'), null); assert.equal(await store.receipt('missing', 'same-command'), null);
      assert.deepEqual(await store.events('missing', 0), []); assert.deepEqual(await store.deliveries('missing'), []);
    });
  });

  test(`${adapter}: event cursors are exclusive and sequence numbers are local to each work`, async () => {
    await withRepository(adapter, async store => {
      const first = command(initial(), 'accept'); first.events.push({ type: 'second', at: 1000, data: { value: 2 } });
      await store.commit(first); await store.commit(command(initial('other'), 'accept'));
      await store.commit(command(advance(first.next), 'advance')); await store.commit(first);
      for (const [cursor, sequences] of [[0, [1, 2, 3]], [1, [2, 3]], [2, [3]], [3, []], [99, []]] as const) {
        assert.deepEqual((await store.events(first.workId, cursor)).map(e => e.sequence), sequences);
      }
      assert.deepEqual((await store.events('other', 0)).map(e => [e.sequence, e.revision]), [[1, 1]]);
    });
  });

  test(`${adapter}: runnable respects exact deadline, obligation, tool and model recovery boundaries after reopen`, async () => {
    await withRepository(adapter, async (store, directory) => {
      const entries: { state: WorkState; before: boolean; at: boolean }[] = [];
      function add(id: string, modify: (state: WorkState) => void, before: boolean, at = before) {
        const state = initial(id); state.status = 'waiting'; modify(state); entries.push({ state, before, at });
      }
      add('ready', s => { s.status = 'ready'; }, true); add('running', s => { s.status = 'running'; }, true);
      add('deadline', s => { s.deadlineAt = 2000; }, false, true);
      add('waiting', () => {}, false);
      for (const status of ['pending', 'satisfied', 'waived'] as const) {
        add(`obligation-${status}`, s => { s.obligations = [{ id: 'reply', kind: 'response', reason: 'Reply', status, wakeKey: null, dueAt: 2000 }]; }, false, status === 'pending');
      }
      add('obligation-null', s => { s.obligations = [{ id: 'reply', kind: 'response', reason: 'Reply', status: 'pending', wakeKey: null, dueAt: null }]; }, false);
      for (const status of ['blocked', 'paused', 'cancelled', 'failed', 'completed'] as const) {
        add(`terminal-${status}`, s => { s.status = status; s.deadlineAt = 1000; }, false);
      }
      for (const status of ['reserved', 'running', 'received', 'succeeded', 'partial', 'failed', 'cancelled', 'unknown'] as const) {
        add(`tool-${status}`, s => { s.attempts = [attempt(status)]; }, status === 'received', ['reserved', 'running', 'received'].includes(status));
      }
      for (const status of ['reserved', 'running', 'received', 'accepted', 'rejected', 'unknown', 'cancelled'] as const) {
        add(`model-${status}`, s => { s.modelCalls = [modelCall(status)]; }, status === 'received', ['reserved', 'running', 'received'].includes(status));
      }
      for (const status of ['reserved', 'running'] as const) add(`model-expired-${status}`, s => { s.modelCalls = [modelCall(status, 9999, true)]; }, true);
      add('paused-tool-received', s => { s.status = 'paused'; s.attempts = [attempt('received')]; }, true);
      add('cancelled-model-received', s => { s.status = 'cancelled'; s.modelCalls = [modelCall('received')]; }, true);
      for (const { state } of entries) await store.commit(command(state, 'accept'));
      const reopened = openRepository(adapter, directory);
      try {
        for (const repository of [store, reopened]) {
          assert.deepEqual((await repository.runnable(1999)).sort(), entries.filter(e => e.before).map(e => e.state.id).sort());
          assert.deepEqual((await repository.runnable(2000)).sort(), entries.filter(e => e.at).map(e => e.state.id).sort());
        }
      } finally { await reopened.close(); }
    });
  });

  for (const race of ['revision', 'same-command', 'different-digest'] as const) {
    test(`${adapter}: two separate processes race on ${race} with exactly one atomic winning commit`, { timeout: 20000 }, async () => {
      await withRepository(adapter, async (store, directory) => {
        const first = command(initial(), 'accept', [delivery()]); await store.commit(first);
        const left = command(advance(first.next, 'left-winner'), 'left', [{ ...delivery(), text: 'Left payload' }]);
        const right = race === 'revision' ? command(advance(first.next, 'right-winner'), 'right', [{ ...delivery(), text: 'Right payload' }]) : structuredClone(left);
        if (race === 'different-digest') { right.commandDigest = 'different'; right.next.statusReason = 'right-winner'; right.deliveries[0]!.text = 'Right payload'; }
        const workers = await Promise.all([worker(adapter, directory), worker(adapter, directory)]);
        try {
          const results = await Promise.all(workers.map((child, index) => child.request({ operation: 'commit', request: index === 0 ? left : right }))) as CommitResult[];
          assert.deepEqual(results.map(r => r.kind).sort(), ['committed', race === 'revision' ? 'conflict' : race === 'same-command' ? 'duplicate' : 'idempotency_conflict'].sort());
          const winnerIndex = results.findIndex(r => r.kind === 'committed'); const winner = winnerIndex === 0 ? left : right;
          assert.deepEqual(await store.get(first.workId), winner.next);
          assert.deepEqual(await store.deliveries(first.workId), winner.deliveries);
          assert.deepEqual((await store.events(first.workId, 0)).map(e => [e.sequence, e.commandId]), [[1, 'accept'], [2, winner.commandId]]);
          assert.deepEqual(await store.receipt(first.workId, winner.commandId), { digest: winner.commandDigest, state: winner.next });
          if (race === 'revision') { const loser = winnerIndex === 0 ? right : left; assert.equal(await store.receipt(first.workId, loser.commandId), null); }
          if (race === 'same-command') assert.deepEqual(results.find(r => r.kind === 'duplicate'), { kind: 'duplicate', state: winner.next });
        } finally { workers.forEach(child => child.dispose()); }
      });
    });
  }

  test(`${adapter}: acknowledged commit survives SIGKILL without close and reopening replays its receipt without duplicate records`, { timeout: 20000 }, async () => {
    await withRepository(adapter, async (store, directory) => {
      const first = command(initial(), 'accept', [delivery()]); await store.commit(first);
      const next = advance(first.next, 'waiting'); next.status = 'waiting';
      next.obligations.push({ id: 'reply', kind: 'response', reason: 'Wait', status: 'pending', wakeKey: 'reply', dueAt: 2000 });
      const committed = command(next, 'wait', [{ ...delivery(), status: 'delivered', externalId: 'receiver-ack' }, { ...delivery('work-1', 'question'), kind: 'question' }]);
      committed.events.push({ type: 'question_prepared', at: next.updatedAt, data: { obligation: 'reply' } });
      const writer = await worker(adapter, directory);
      try { assert.deepEqual(await writer.request({ operation: 'commit', request: committed, crashAfterCommit: true }), { kind: 'committed', state: committed.next }); }
      finally { writer.dispose(); }
      const expected = { state: committed.next,
        events: [...first.events.map((e, i) => ({ ...e, workId: first.workId, revision: 1, commandId: first.commandId, sequence: i + 1 })),
          ...committed.events.map((e, i) => ({ ...e, workId: first.workId, revision: 2, commandId: committed.commandId, sequence: first.events.length + i + 1 }))],
        deliveries: committed.deliveries,
        receipts: { accept: { digest: first.commandDigest, state: first.next }, wait: { digest: committed.commandDigest, state: committed.next } } };
      assert.deepEqual(await snapshot(store, first.workId, ['accept', 'wait']), expected);
      const reader = await worker(adapter, directory);
      try { assert.deepEqual(await reader.request({ operation: 'read', workId: first.workId, commandIds: ['accept', 'wait'] }), expected); }
      finally { reader.dispose(); }
      const retry = await worker(adapter, directory);
      try { assert.deepEqual(await retry.request({ operation: 'commit', request: committed }), { kind: 'duplicate', state: committed.next }); }
      finally { retry.dispose(); }
      const reopened = openRepository(adapter, directory);
      try {
        assert.deepEqual(await snapshot(reopened, first.workId, ['accept', 'wait']), expected);
        assert.deepEqual(await reopened.runnable(1999), []); assert.deepEqual(await reopened.runnable(2000), [first.workId]);
      } finally { await reopened.close(); }
    });
  });
}
