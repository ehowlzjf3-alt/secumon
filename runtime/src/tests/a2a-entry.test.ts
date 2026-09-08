import test from 'node:test';
import assert from 'node:assert/strict';
import { A2aMessageSchema, A2aTaskSchema, type A2aMessage } from '../application/a2a-contracts.js';
import { a2aEntryFixture, a2aObject, a2aResultTask } from './a2a-entry-fixture.js';

type Fixture = Awaited<ReturnType<typeof a2aEntryFixture>>;
const sendRequest = (message: A2aMessage, id = message.messageId) => ({ jsonrpc: '2.0', id, method: 'SendMessage',
  params: { message, configuration: { returnImmediately: true } } });
const message = (id: string, text: string): A2aMessage => ({ messageId: id, role: 'ROLE_USER', parts: [{ text }] });
const taskOf = (reply: unknown) => a2aResultTask(a2aObject(reply)['result']);
const getRequest = (id: string, requestId = 'read-' + id) => ({ jsonrpc: '2.0', id: requestId, method: 'GetTask', params: { id } });
async function isolated(f: Fixture) {
  const sender = f.current('sender'), receiver = f.current('receiver');
  assert.equal(sender.actor.principalId, receiver.actor.principalId); assert.notEqual(sender.agentId, receiver.agentId);
  assert.notEqual(sender.scope, receiver.scope); assert.notEqual(sender.services.state, receiver.services.state);
  for (const role of ['sender', 'receiver'] as const) {
    const other = role === 'sender' ? 'receiver' : 'sender', profile = f.current(role);
    assert.deepEqual(await f.memory(role), []);
    assert.equal(await profile.services.artifacts.exists(f.raw(other)), false);
    await assert.rejects(profile.services.artifacts.get(f.raw(other), profile.policy));
    assert.equal(JSON.stringify(f.observed.inputs[role]).includes(other + '_PRIVATE_ORIGINAL'), false);
  }
}

test('A2A entry: model send returns only an acknowledgement, explicit receiver execution precedes model get and an unverified local report', { timeout: 120000 }, async t => {
  const f = await a2aEntryFixture(t), accepted = await f.acceptSender(), sender = f.current('sender');
  const sent = await f.through(accepted.workId, 'send'); assert.equal(sent.result?.status, 'success'); assert.equal(sent.attempt.adopted, true);
  assert.equal(sent.result.effectState, 'confirmed'); assert.deepEqual(sent.result.evidence, []);
  const remote = a2aResultTask(a2aObject(sent.result.output)['reply']); assert.equal(remote.status.state, 'TASK_STATE_SUBMITTED');
  assert.notEqual(sent.state.status, 'completed'); assert.equal(sent.state.generatedAnswer, undefined); assert.deepEqual(sent.state.evidence, []);
  assert.equal(f.observed.inputs.receiver.length, 0); assert.equal(f.observed.exchanges.length, 1);
  const receiver = f.current('receiver'), original = await receiver.runtime.state(remote.id);
  assert.equal(original.modelCalls.length, 0); assert.equal(original.attempts.length, 0);
  assert.equal(original.conversation?.session?.scope.sessionId, remote.contextId); assert.equal(original.goal.scope, receiver.scope);
  assert.equal(await sender.services.state.get(remote.id), null); assert.equal(await receiver.services.state.get(accepted.workId), null);
  const receivedMessage = A2aMessageSchema.parse(a2aObject(f.observed.exchanges[0]!.request['params'])['message']);
  assert.equal(original.goal.description, JSON.stringify(receivedMessage));
  assert.equal(receivedMessage.metadata?.['callerId'], 'untrusted-caller');
  assert.equal(original.policy.principalId, receiver.actor.principalId); assert.equal(original.conversation?.session?.scope.agentId, receiver.agentId);
  const handler = await f.handler(); assert.equal(handler.sessionId, remote.contextId);
  assert.equal((await handler.run(remote.id)).control.kind, 'complete');
  const got = await f.through(accepted.workId, 'get'); assert.equal(got.result?.status, 'success'); assert.equal(got.attempt.adopted, true);
  assert.equal(got.result.effectState, 'none'); assert.deepEqual(got.result.evidence, []); assert.deepEqual(got.state.evidence, []);
  assert.equal(a2aObject(got.result.output)['kind'], 'unreviewed_a2a_reply'); assert.notEqual(got.state.status, 'completed');
  const result = A2aTaskSchema.parse(a2aObject(got.result.output)['reply']); assert.equal(result.status.state, 'TASK_STATE_COMPLETED'); assert.equal(result.id, remote.id);
  assert.equal(f.observed.inputs.receiver.length, 1); assert.equal(f.observed.exchanges.length, 2);
  const done = await sender.workflow.run(accepted.workId, sender.executionActor, { maxSteps: 10 }); assert.equal(done.control.kind, 'complete');
  const final = await sender.runtime.state(accepted.workId); assert.equal(final.budget.used.toolCalls, 2); assert.deepEqual(final.evidence, []);
  const receiverState = await receiver.runtime.state(remote.id), deliveries = await receiver.services.state.deliveries(remote.id);
  assert.equal(deliveries.filter(value => value.kind === 'result' && value.status === 'delivered').length, 1);
  const originalRequest = structuredClone(f.observed.exchanges[0]!.request), calls = f.observed.inputs.receiver.length;
  await isolated(f); await f.reopen();
  const reopened = await f.handler(); assert.equal(reopened.sessionId, handler.sessionId);
  const repeated = taskOf(await reopened.handle('1.0', originalRequest)); assert.equal(repeated.id, remote.id);
  assert.equal(repeated.status.state, 'TASK_STATE_COMPLETED'); assert.equal(f.observed.inputs.receiver.length, calls);
  assert.deepEqual(await f.current('receiver').runtime.state(remote.id), receiverState);
  assert.deepEqual(await f.current('receiver').services.state.deliveries(remote.id), deliveries);
  assert.equal((await f.acceptSender()).workId, accepted.workId); await isolated(f);
});

test('A2A entry: original message identity survives retransmission while callers and independently stored agents remain isolated', { timeout: 120000 }, async t => {
  const f = await a2aEntryFixture(t), first = await f.handler('receiver', 'caller-a'), other = await f.handler('receiver', 'caller-b');
  const request = sendRequest(message('same-message', 'Preserve the original input.'));
  const accepted = taskOf(await first.handle('1.0', request)), original = await f.current('receiver').runtime.state(accepted.id);
  const repeated = taskOf(await first.handle('1.0', { ...request, id: 'another-rpc-id' })); assert.equal(repeated.id, accepted.id);
  assert.deepEqual(await f.current('receiver').runtime.state(accepted.id), original);
  await assert.rejects(first.handle('1.0', sendRequest(message('same-message', 'Altered original text.'), 'changed-rpc')));
  assert.deepEqual(await f.current('receiver').runtime.state(accepted.id), original);
  await assert.rejects(other.handle('1.0', getRequest(accepted.id)), /a2a_task_unavailable/);
  const second = taskOf(await other.handle('1.0', request)); assert.notEqual(second.id, accepted.id); assert.notEqual(second.contextId, accepted.contextId);
  const separate = await f.handler('sender', 'caller-a');
  const third = taskOf(await separate.handle('1.0', request)); assert.notEqual(third.id, accepted.id); assert.notEqual(third.contextId, accepted.contextId);
  assert.equal(await f.current('sender').services.state.get(accepted.id), null);
  assert.equal(await f.current('receiver').services.state.get(third.id), null);
  await assert.rejects(first.handle('1.0', getRequest(third.id)), /work_unavailable/);
  const wrongContext = await first.handle('1.0', sendRequest({ ...message('bad-context', 'Do not retarget.'), contextId: second.contextId }));
  assert.equal(a2aObject(wrongContext)['result'], undefined); assert.equal(a2aObject(a2aObject(wrongContext)['error'])['code'], -32602);
  assert.equal(f.observed.inputs.sender.length, 0); assert.equal(f.observed.inputs.receiver.length, 0); await isolated(f);
});

test('A2A entry: a delivered question and its original answer command survive reopen, and cancellation does not execute a waiting task', { timeout: 120000 }, async t => {
  const f = await a2aEntryFixture(t), handler = await f.handler();
  const ask = { ...message('ask-original', 'Prepare a dated note.'), parts: [{ text: 'Prepare a dated note.' }, { data: { operation: 'ask' } }] };
  const accepted = taskOf(await handler.handle('1.0', sendRequest(ask)));
  await handler.run(accepted.id);
  const waiting = A2aTaskSchema.parse(a2aObject(await handler.handle('1.0', getRequest(accepted.id)))['result']);
  assert.equal(waiting.status.state, 'TASK_STATE_INPUT_REQUIRED'); assert.match(waiting.status.message?.parts[0] && 'text' in waiting.status.message.parts[0] ? waiting.status.message.parts[0].text : '', /Which date/);
  const before = await f.current('receiver').runtime.state(accepted.id), reply = sendRequest({ ...message('answer-original', 'Use the supplied date.'),
    taskId: accepted.id, contextId: accepted.contextId, parts: [{ data: { answer: '2026-09-08' } }] });
  const acknowledged = taskOf(await handler.handle('1.0', reply)); assert.equal(acknowledged.id, accepted.id);
  const applied = await f.current('receiver').runtime.state(accepted.id);
  assert.equal(f.observed.inputs.receiver.length, 1); assert.deepEqual(applied.goal, before.goal); assert.deepEqual(applied.budget, before.budget);
  await f.reopen(); const resumed = await f.handler();
  assert.equal(taskOf(await resumed.handle('1.0', reply)).id, accepted.id);
  assert.deepEqual(await f.current('receiver').runtime.state(accepted.id), applied);
  assert.equal((await resumed.run(accepted.id)).control.kind, 'complete');
  const completed = A2aTaskSchema.parse(a2aObject(await resumed.handle('1.0', getRequest(accepted.id)))['result']);
  assert.equal(completed.status.state, 'TASK_STATE_COMPLETED'); assert.match(JSON.stringify(completed.artifacts), /2026-09-08/);
  const after = await f.current('receiver').runtime.state(accepted.id); assert.deepEqual(after.evidence, []);
  assert.equal(after.obligations.filter(value => value.status === 'pending' && value.kind === 'response').length, 0);
  const cancelTarget = taskOf(await resumed.handle('1.0', sendRequest(message('cancel-original', 'Pending request to cancel.'))));
  assert.equal(cancelTarget.contextId, accepted.contextId); assert.notEqual(cancelTarget.id, accepted.id);
  const cancel = { jsonrpc: '2.0', id: 'cancel-once', method: 'CancelTask', params: { id: cancelTarget.id } };
  const cancelled = A2aTaskSchema.parse(a2aObject(await resumed.handle('1.0', cancel))['result']); assert.equal(cancelled.status.state, 'TASK_STATE_CANCELED');
  const saved = await f.current('receiver').runtime.state(cancelTarget.id);
  await resumed.handle('1.0', cancel); await resumed.run(cancelTarget.id);
  const unchanged = await f.current('receiver').runtime.state(cancelTarget.id);
  assert.deepEqual(unchanged.attempts, saved.attempts); assert.deepEqual(unchanged.modelCalls, saved.modelCalls); assert.deepEqual(unchanged.budget, saved.budget);
  assert.equal(unchanged.modelCalls.length, 0); assert.equal(f.observed.inputs.receiver.length, 2); await isolated(f);
});

test('A2A entry: a lost send acknowledgement leaves the local write unknown and preserves the once accepted remote task without replay', { timeout: 120000 }, async t => {
  const f = await a2aEntryFixture(t); f.controls.loseSendResponse = true;
  const accepted = await f.acceptSender(), sent = await f.through(accepted.workId, 'send');
  assert.equal(sent.attempt.effectState, 'unknown'); assert.equal(sent.attempt.adopted, false); assert.notEqual(sent.state.status, 'completed');
  assert.deepEqual(sent.state.evidence, []); assert.equal(f.observed.exchanges.length, 1); assert.equal(f.observed.inputs.receiver.length, 0);
  const exchange = f.observed.exchanges[0]!, remote = taskOf(exchange.response), receiver = f.current('receiver');
  assert.equal(remote.status.state, 'TASK_STATE_SUBMITTED'); const original = await receiver.runtime.state(remote.id);
  const attempt = structuredClone(sent.attempt), sourceBytes = sent.attempt.resultArtifact ? await f.current('sender').services.artifacts.get(sent.attempt.resultArtifact, sent.state.policy) : null;
  await f.reopen(); f.controls.loseSendResponse = false;
  const sender = f.current('sender'), before = f.observed.inputs.sender.length;
  const stopped = await sender.workflow.run(accepted.workId, sender.executionActor, { maxSteps: 10 });
  assert.ok(['wait', 'blocked'].includes(stopped.control.kind), JSON.stringify(stopped));
  const after = await sender.runtime.state(accepted.workId);
  assert.deepEqual(after.attempts.find(value => value.id === attempt.id), attempt); assert.equal(after.budget.used.toolCalls, 1);
  assert.equal(f.observed.inputs.sender.length, before); assert.equal(f.observed.exchanges.length, 1); assert.equal(f.observed.inputs.receiver.length, 0);
  assert.deepEqual(await f.current('receiver').runtime.state(remote.id), original);
  if (sourceBytes && attempt.resultArtifact) assert.deepEqual(await sender.services.artifacts.get(attempt.resultArtifact, after.policy), sourceBytes);
  const handler = await f.handler(); assert.equal(taskOf(await handler.handle('1.0', exchange.request)).id, remote.id);
  assert.deepEqual(await f.current('receiver').runtime.state(remote.id), original); await isolated(f);
});

test('A2A entry: closing a receiver handler interrupts and drains its accepted model call and refuses retained entry points', { timeout: 120000 }, async t => {
  const f = await a2aEntryFixture(t), handler = await f.handler();
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let released!: () => void; const gate = new Promise<void>(resolve => { released = resolve; });
  f.controls.beforeReceiverReply = async signal => { entered(); await gate; signal.throwIfAborted(); };
  const accepted = taskOf(await handler.handle('1.0', sendRequest(message('close-original', 'Close while the model is awaiting its reply.'))));
  const running = handler.run(accepted.id); void running.catch(() => {});
  let closing: Promise<void> | undefined;
  try {
    await Promise.race([started, running.then(() => { throw new Error('a2a_handler_finished_before_model_gate'); })]); let finished = false;
    closing = handler.close().then(() => { finished = true; });
    await assert.rejects(handler.handle('1.0', getRequest(accepted.id))); await assert.rejects(handler.run(accepted.id));
    assert.equal(finished, false); released(); await Promise.allSettled([running]); await closing;
    assert.equal(finished, true); assert.equal(f.observed.inputs.receiver.length, 1);
    const state = await f.current('receiver').runtime.state(accepted.id); assert.notEqual(state.status, 'completed'); assert.equal(state.generatedAnswer, undefined);
    assert.equal(state.modelCalls.length, 1); assert.equal(state.budget.used.modelCalls, 1); assert.deepEqual(state.evidence, []);
    assert.equal((await f.current('receiver').services.state.deliveries(accepted.id)).filter(value => value.kind === 'result').length, 0);
  } finally { released(); await Promise.allSettled([running, ...(closing ? [closing] : [])]); }
});
