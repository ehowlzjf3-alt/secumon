import test from 'node:test';
import assert from 'node:assert/strict';
import { Sha256Digester } from '../infrastructure/digest.js';
import { asJson } from '../application/plan-validator.js';
import { executionControl } from '../domain/execution-policy.js';
import { SessionService } from '../application/session-service.js';
import { HOST_ENTRY_TEXT } from './host-tool-entry-fixture.js';
import { knoxEntryFixture, KNOX_REPLY } from './knox-entry-fixture.js';

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`${backend}: Knox acknowledges before execution and preserves a quiet persistent session across redelivery and reopen`, { timeout: 60000 }, async t => {
    const f = knoxEntryFixture(t, backend); let app = await f.open(), c = app.conversation;
    const input = { messageId: 'same-message', rawText: HOST_ENTRY_TEXT }, first = await c.accept(input);
    assert.equal(first.accepted, true); assert.equal(f.observed.modelInputs.length, 0); assert.equal(f.observed.reads, 0);
    assert.deepEqual(f.wire.sends.map(m => m.kind), ['ack']);
    assert.equal(f.wire.sends[0]!.conversationId, 'conversation-a'); assert.equal(f.wire.sends[0]!.recipientId, 'operator');
    const before = await f.image(first.workId, first.sessionId);
    assert.equal((await c.accept(input)).accepted, false);
    assert.deepEqual(await f.image(first.workId, first.sessionId), before);
    assert.equal((await c.run(first.workId)).control.kind, 'complete');
    assert.equal(f.observed.reads, 1); assert.equal(f.observed.modelInputs.length, 2);
    assert.deepEqual(f.wire.sends.map(m => m.kind), ['ack', 'result']); assert.ok(f.wire.sends[1]!.text.includes(KNOX_REPLY));
    const completed = await f.image(first.workId, first.sessionId), sends = f.wire.sends.length, lookups = f.wire.lookups.length;
    await c.status(first.workId); await c.history(); assert.deepEqual(await f.image(first.workId, first.sessionId), completed);
    assert.equal(f.wire.sends.length, sends); assert.equal(f.wire.lookups.length, lookups);
    await f.close(app); app = await f.open(); c = app.conversation;
    assert.equal(c.sessionId, first.sessionId); assert.equal((await c.accept(input)).accepted, false);
    assert.equal((await c.run(first.workId)).control.kind, 'complete');
    assert.deepEqual(await f.image(first.workId, first.sessionId), completed);
    assert.equal(f.observed.reads, 1); assert.equal(f.observed.modelInputs.length, 2);
    const second = await c.accept({ messageId: 'next-request', rawText: '앞서 확인한 문서를 이어서 확인해 줘.' });
    assert.equal(second.sessionId, first.sessionId); assert.notEqual(second.workId, first.workId);
    assert.equal((await c.run(second.workId)).control.kind, 'complete');
    const next = f.observed.modelInputs[2]!;
    assert.ok(next.packet.session?.entries.some(e => e.workId === first.workId && e.role === 'assistant' && e.text.includes(KNOX_REPLY)));
    assert.equal(next.packet.workId, second.workId); assert.equal(next.packet.evidence.length, 0);
    assert.deepEqual(f.wire.sends.map(m => m.kind), ['ack', 'result', 'ack', 'result']);
  });

  test(`${backend}: Knox unknown delivery is reconciled explicitly without status side effects or duplicate transcript entries`, { timeout: 60000 }, async t => {
    const f = knoxEntryFixture(t, backend); f.wire.unknownSend = true; f.wire.lookup = 'unknown';
    let app = await f.open(), c = app.conversation;
    const first = await c.accept({ messageId: 'unknown-delivery', rawText: HOST_ENTRY_TEXT });
    const unknown = await f.image(first.workId, first.sessionId);
    assert.equal(unknown.deliveries.find(d => d.kind === 'ack')?.status, 'unknown');
    assert.equal(unknown.history.entries.filter(e => e.role === 'assistant').length, 0);
    const lookups = f.wire.lookups.length;
    await c.status(first.workId); await c.history();
    assert.equal(f.wire.sends.length, 1); assert.equal(f.wire.lookups.length, lookups);
    assert.deepEqual(await f.image(first.workId, first.sessionId), unknown);
    f.wire.lookup = 'remote'; await c.flush(first.workId); await c.flush(first.workId);
    assert.equal(f.wire.sends.length, 1);
    assert.equal((await c.history()).entries.filter(e => e.role === 'assistant' && e.kind === 'ack').length, 1);
    f.wire.lookup = 'unknown';
    const run = await c.run(first.workId, { maxSteps: 20 }); assert.notEqual(run.control.kind, 'complete');
    assert.equal(f.observed.reads, 1); assert.equal(f.observed.modelInputs.length, 2); assert.equal(f.wire.sends.length, 2);
    const unconfirmed = await f.image(first.workId, first.sessionId);
    assert.equal(unconfirmed.deliveries.find(d => d.kind === 'result')?.status, 'unknown');
    assert.equal(unconfirmed.history.entries.filter(e => e.kind === 'result').length, 0);
    await f.close(app); app = await f.open({ sessionId: first.sessionId }); c = app.conversation;
    const reopenLookups = f.wire.lookups.length;
    await c.status(first.workId); await c.history(); assert.equal(f.wire.lookups.length, reopenLookups);
    assert.deepEqual(await f.image(first.workId, first.sessionId), unconfirmed);
    f.wire.lookup = 'remote'; await c.flush(first.workId); await c.flush(first.workId);
    const confirmed = await f.image(first.workId, first.sessionId);
    assert.equal(confirmed.deliveries.find(d => d.kind === 'result')?.status, 'delivered');
    assert.equal(confirmed.history.entries.filter(e => e.kind === 'result').length, 1);
    assert.equal(f.wire.sends.length, 2); assert.equal(f.observed.reads, 1); assert.equal(f.observed.modelInputs.length, 2);
    assert.equal((await c.run(first.workId)).control.kind, 'complete');
    assert.equal(f.observed.reads, 1); assert.equal(f.observed.modelInputs.length, 2);
  });
}

test('Knox run rejects an unbound work before applying pending commands from its own session', async t => {
  const f = knoxEntryFixture(t, 'sqlite'), app = await f.open(), c = app.conversation;
  const first = await c.accept({ messageId: 'own-work', rawText: HOST_ENTRY_TEXT });
  const other = await f.open({ conversationId: 'another-conversation' });
  const foreign = await other.conversation.accept({ messageId: 'other-work', rawText: HOST_ENTRY_TEXT });
  await f.withStores(async stores => {
    const scope = { ...f.owner, sessionId: first.sessionId }, text = '재시작 뒤 적용해야 할 일시정지 지시';
    const payload = asJson({ expectedGoalRevision: 1, command: { kind: 'pause', reason: 'pending-command' } });
    const kind = 'command', workId = first.workId;
    await stores.sessions.receive({ scope, messageId: 'pending-pause', text, payload, kind, workId,
      digest: new Sha256Digester().digest(asJson({ scope, text, payload, kind, workId })), labels: ['internal', 'public'], receivedAt: Date.now() });
  });
  const before = await f.image(first.workId, first.sessionId); assert.equal(before.pending.length, 1);
  await assert.rejects(c.run(foreign.workId), /session_work_unavailable/);
  assert.deepEqual(await f.image(first.workId, first.sessionId), before, 'a rejected work cannot apply an unrelated pending command');
  await assert.rejects(c.run('missing-work'), /work_unavailable/);
  assert.deepEqual(await f.image(first.workId, first.sessionId), before);
  assert.equal((await c.run(first.workId)).control.kind, 'paused');
  assert.equal((await f.image(first.workId, first.sessionId)).pending.length, 0);
  assert.equal(f.observed.reads, 0); assert.equal(f.observed.modelInputs.length, 0);
});

for (const idempotentSend of [false, true]) test(`Knox lookup absent retries only on a later flush with idempotentSend=${idempotentSend}`, async t => {
  const f = knoxEntryFixture(t, 'sqlite', idempotentSend); f.wire.unknownSend = true;
  const app = await f.open(), c = app.conversation, first = await c.accept({ messageId: 'absent-receipt', rawText: HOST_ENTRY_TEXT });
  const key = f.wire.sends[0]!.idempotencyKey;
  // Simulate the transport proving absence after an ambiguous send; no corporate server is contacted.
  f.wire.receipts.clear(); f.wire.lookup = 'absent';
  await c.flush(first.workId); assert.equal(f.wire.sends.length, 1);
  assert.equal((await f.image(first.workId, first.sessionId)).deliveries.find(d => d.kind === 'ack')?.status,
    idempotentSend ? 'pending' : 'unknown');
  f.wire.unknownSend = false; await c.flush(first.workId);
  assert.equal(f.wire.sends.length, idempotentSend ? 2 : 1);
  assert.ok(f.wire.sends.every(message => message.idempotencyKey === key));
  assert.equal((await c.history()).entries.filter(e => e.role === 'assistant' && e.kind === 'ack').length, idempotentSend ? 1 : 0);
  assert.equal(f.observed.modelInputs.length, 0); assert.equal(f.observed.reads, 0);
});

test('Knox binds work operations to the authenticated agent, recipient, conversation and session', async t => {
  const f = knoxEntryFixture(t, 'sqlite'), app = await f.open(), first = await app.conversation.accept({ messageId: 'bound', rawText: HOST_ENTRY_TEXT });
  const other = await f.open({ conversationId: 'another-conversation' });
  const foreign = knoxEntryFixture(t, 'file-journal'), otherAgent = await foreign.open();
  const before = await f.image(first.workId, first.sessionId);
  for (const c of [other.conversation, otherAgent.conversation]) {
    const input = { workId: first.workId, messageId: 'intrusion', rawText: '다른 업무를 수정', expectedGoalRevision: 1 };
    for (const action of [() => c.run(first.workId), () => c.status(first.workId), () => c.flush(first.workId),
      () => c.control({ ...input, kind: 'cancel' }), () => c.followUp({ ...input, action: { kind: 'continue' } }),
      () => c.changeGoal({ ...input, expectedControlRevision: 1 })])
      await assert.rejects(action(), /work_unavailable|session_work_unavailable/);
  }
  for (const route of [{ tenantId: 'someone-else' }, { principalId: 'someone-else' }])
    await assert.rejects(f.open(route), /knox_actor_mismatch/);
  await assert.rejects(foreign.open({ sessionId: first.sessionId }), /session_unavailable/);
  assert.deepEqual(await f.image(first.workId, first.sessionId), before);
  assert.equal(f.observed.reads, 0); assert.equal(f.observed.modelInputs.length, 0);
  assert.equal(foreign.observed.reads, 0); assert.equal(foreign.observed.modelInputs.length, 0);
});

test('Knox control, followup and goal change preserve explicit versions and original messages without implicit execution', async t => {
  const f = knoxEntryFixture(t, 'sqlite'), app = await f.open(), c = app.conversation;
  const first = await c.accept({ messageId: 'request', rawText: HOST_ENTRY_TEXT });
  const pause = { workId: first.workId, messageId: 'pause', rawText: '잠시 멈춰 줘.', expectedGoalRevision: 1, kind: 'pause' as const };
  assert.equal((await c.control(pause)).created, true); assert.equal((await c.control(pause)).created, false);
  assert.equal((await c.run(first.workId)).control.kind, 'paused');
  await c.control({ ...pause, messageId: 'resume', rawText: '이어서 진행해 줘.', kind: 'resume' });
  await c.followUp({ workId: first.workId, messageId: 'more', rawText: '답변은 간단히 해 줘.', expectedGoalRevision: 1, action: { kind: 'continue' } });
  const before = await f.image(first.workId, first.sessionId), revision = executionControl(before.state).revision;
  assert.equal(before.state.goal.revision, 1); assert.equal(before.state.goal.description, HOST_ENTRY_TEXT);
  const change = { workId: first.workId, messageId: 'goal', rawText: '문서의 현재 내용을 새 목표로 확인해 줘.', expectedGoalRevision: 1, expectedControlRevision: revision };
  assert.equal((await c.changeGoal(change)).created, true); assert.equal((await c.changeGoal(change)).created, false);
  const after = await f.image(first.workId, first.sessionId); assert.equal(after.state.goal.revision, 2); assert.equal(after.state.goal.description, change.rawText);
  await assert.rejects(c.run(first.workId, { expectedGoalRevision: 1 }), /^Error: stale_user_command$/);
  assert.equal(f.observed.modelInputs.length, 0); assert.equal(f.observed.reads, 0);
  assert.deepEqual((await c.history()).entries.filter(e => e.role === 'user').map(e => e.sourceId), ['request', 'pause', 'resume', 'more', 'goal']);
});

test('Knox can resume its own durable request when intake stopped before creating the work', async t => {
  const f = knoxEntryFixture(t, 'sqlite'), app = await f.open(), c = app.conversation;
  const stopped = t.mock.method(SessionService.prototype, 'resume', async () => { throw new Error('fixture_intake_interrupted'); });
  try { await assert.rejects(c.accept({ messageId: 'interrupted', rawText: HOST_ENTRY_TEXT }), /fixture_intake_interrupted/); }
  finally { stopped.mock.restore(); }
  const pending = await f.withStores(async stores => {
    const entries = await stores.sessions.pending({ ...f.owner, sessionId: c.sessionId }, 256);
    assert.equal(entries.length, 1); assert.equal(entries[0]!.kind, 'work');
    assert.equal(await stores.state.get(entries[0]!.workId), null); return entries[0]!;
  });
  assert.equal(f.wire.sends.length, 0); assert.equal(f.observed.modelInputs.length, 0);
  const alias = await f.open({ conversationId: 'another-conversation', sessionId: c.sessionId });
  // Explicit session reconnection can read its history, but does not authorize another route's work.
  assert.equal((await alias.conversation.history()).entries.some(entry => entry.sourceId === 'interrupted'), true);
  await assert.rejects(alias.conversation.run(pending.workId), /^Error: work_unavailable$/);
  await f.withStores(async stores => {
    assert.equal(await stores.state.get(pending.workId), null);
    assert.deepEqual(await stores.sessions.pending({ ...f.owner, sessionId: c.sessionId }, 256), [pending]);
  });
  assert.equal((await c.run(pending.workId)).control.kind, 'complete');
  const after = await f.image(pending.workId, c.sessionId);
  assert.equal(after.pending.length, 0); assert.equal(after.state.conversation?.session?.input.messageId, 'interrupted');
  assert.equal(after.history.entries.filter(e => e.role === 'user').length, 1);
  assert.deepEqual(f.wire.sends.map(m => m.kind), ['ack', 'result']); assert.equal(f.observed.reads, 1);
});

test('Knox rejects a simultaneous run and releases the local reservation when it finishes', async t => {
  const f = knoxEntryFixture(t, 'sqlite'), registration = f.host.tools!;
  let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered: () => void = () => {}; const started = new Promise<void>(resolve => { entered = resolve; });
  const host = { ...f.host, tools: { async open(...args: Parameters<typeof registration.open>) {
    const opened = await registration.open(...args);
    return { ...opened, tools: opened.tools.map(tool => ({ ...tool, async execute(...args: Parameters<typeof tool.execute>) {
      entered(); await gate; return tool.execute(...args);
    } })) };
  } } };
  const app = await f.open({}, host), c = app.conversation;
  const first = await c.accept({ messageId: 'concurrent', rawText: HOST_ENTRY_TEXT }), pending = c.run(first.workId);
  try { await Promise.race([started, pending.then(() => { throw new Error('knox_fixture_tool_not_reached'); })]);
    await assert.rejects(c.run(first.workId), /^Error: messenger_work_running$/); }
  finally { release(); }
  assert.equal((await pending).control.kind, 'complete'); assert.equal(f.observed.reads, 1);
  assert.equal((await c.run(first.workId)).control.kind, 'complete'); assert.equal(f.observed.reads, 1);
});

test('Knox rejects new inbound work from the start of close before stores finish draining', async t => {
  const f = knoxEntryFixture(t, 'sqlite'), registration = f.host.models!.get('host-entry-v1')!;
  let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered: () => void = () => {}; const closing = new Promise<void>(resolve => { entered = resolve; });
  const host = { ...f.host, models: new Map([['host-entry-v1', { ...registration, async open(...args: Parameters<typeof registration.open>) {
    const opened = await registration.open(...args);
    return { ...opened, async close() { entered(); await gate; await opened.close?.(); } };
  } }]]) };
  const app = await f.open({}, host), c = app.conversation;
  const first = await c.accept({ messageId: 'before-close', rawText: HOST_ENTRY_TEXT });
  const before = await f.image(first.workId, first.sessionId), sends = f.wire.sends.length;
  const done = app.close();
  try {
    await Promise.race([closing, done.then(() => { throw new Error('knox_fixture_close_not_reached'); })]);
    await assert.rejects(c.accept({ messageId: 'during-close', rawText: '종료 중 새 입력' }), /messenger_closed/);
    const input = { workId: first.workId, messageId: 'during-close-control', rawText: '종료 중 지시', expectedGoalRevision: 1 };
    for (const action of [() => c.control({ ...input, kind: 'pause' }), () => c.followUp({ ...input, action: { kind: 'continue' } }),
      () => c.changeGoal({ ...input, expectedControlRevision: 1 }), () => c.run(first.workId), () => c.status(first.workId), () => c.history(), () => c.flush(first.workId)])
      await assert.rejects(action(), /messenger_closed/);
    assert.deepEqual(await f.image(first.workId, first.sessionId), before);
    assert.equal(f.wire.sends.length, sends); assert.equal(f.observed.modelInputs.length, 0); assert.equal(f.observed.reads, 0);
  } finally { release(); await done; }
  await f.close(app); assert.equal(f.observed.modelCloses, 1); assert.equal(f.observed.toolCloses, 1);
});
