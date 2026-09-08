import test from 'node:test';
import assert from 'node:assert/strict';
import type { A2aMessage } from '../application/a2a-contracts.js';
import type { Policy } from '../domain/model.js';
import { openHostA2a, type HostA2aRegistration } from '../presentation/host-a2a.js';
import { openAgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { HOST_ENTRY_TEXT } from './host-tool-entry-fixture.js';
import { A2A_REGISTRATION_ID, a2aInvocation, a2aRegistrationFixture, a2aRegistrationProbe, a2aTask,
  bounded, errorLeaves, gate } from './host-a2a-registration-fixture.js';

test('A2A registration: off never selects either host capability and the ordinary session survives reopen', { timeout: 60000 }, async t => {
  const f = a2aRegistrationFixture(t, false), selections = { outbound: 0, inbound: 0 };
  const host = { ...f.entry.host,
    get a2a(): never { selections.outbound++; throw new Error('disabled_a2a_selected'); },
    get a2aInbound(): never { selections.inbound++; throw new Error('disabled_a2a_inbound_selected'); } };
  const profile = f.track(await openAgentTurnProfile(f.directory, { provider: 'registered' }, host));
  assert.equal(profile.a2a, null); assert.equal(profile.contracts.visible(profile.policy).some(value => value.provider === A2A_REGISTRATION_ID), false);
  const session = await profile.sessions.open(profile.actor, { channel: 'test', conversationId: 'a2a-off' });
  const accepted = await profile.turns.accept(profile.actor, { sessionId: session.scope.sessionId, messageId: 'ordinary-original', rawText: HOST_ENTRY_TEXT,
    binding: { ...profile.executionActor, channel: 'test', conversationId: 'a2a-off', recipientId: profile.actor.principalId, destination: 'local' },
    scope: profile.scope, mode: 'auto', policy: profile.policy, limits: profile.limits });
  assert.equal((await profile.workflow.run(accepted.workId, profile.executionActor)).control.kind, 'complete');
  const history = await profile.sessions.history(profile.actor, session.scope.sessionId, profile.policy, { limit: 100 });
  assert.equal(history.entries.filter(value => value.kind === 'result').length, 1);
  await profile.close(); const calls = f.entry.observed.modelInputs.length;
  const reopened = f.track(await openAgentTurnProfile(f.directory, { provider: 'registered' }, host));
  assert.equal((await reopened.sessions.open(reopened.actor, { channel: 'test', conversationId: 'a2a-off' })).scope.sessionId, session.scope.sessionId);
  assert.deepEqual(await reopened.sessions.history(reopened.actor, session.scope.sessionId, reopened.policy, { limit: 100 }), history);
  assert.equal((await reopened.workflow.run(accepted.workId, reopened.executionActor)).control.kind, 'complete');
  assert.equal(f.entry.observed.modelInputs.length, calls); assert.equal(f.entry.observed.reads, 1);
  assert.ok(f.entry.observed.modelInputs.every(value => value.packet.activeToolIds.every(id => !id.startsWith(A2A_REGISTRATION_ID + '.'))));
  assert.deepEqual(selections, { outbound: 0, inbound: 0 });
});

test('A2A registration: enabled without either explicit capability fails before tool or model resources open', async t => {
  const f = a2aRegistrationFixture(t);
  assert.equal(await openHostA2a(undefined, f.context), null);
  await assert.rejects(openAgentTurnProfile(f.directory, { provider: 'registered' }, { ...f.entry.host, a2aInbound: false }), /agent_a2a_registration_required/);
  assert.equal(f.entry.observed.toolContexts.length, 0); assert.equal(f.entry.observed.modelInputs.length, 0);
  assert.equal(f.entry.observed.toolCloses, 0); assert.equal(f.entry.observed.modelCloses, 0);
});

test('A2A registration: inbound-only opens a caller-bound handler without outbound tools and closes retained handlers', { timeout: 15000 }, async t => {
  const f = a2aRegistrationFixture(t);
  const profile = f.track(await openAgentTurnProfile(f.directory, { provider: 'registered' }, { ...f.entry.host, a2aInbound: true }));
  assert.equal(profile.a2a, null); assert.equal(profile.policy.allowWrites, false);
  assert.equal(profile.contracts.visible(profile.policy).some(value => value.provider === A2A_REGISTRATION_ID), false);
  const caller = { callerId: 'authenticated-caller', actor: profile.actor, policy: profile.policy, destination: 'local', maxSteps: 1 };
  await assert.rejects(profile.openA2aHandler({ ...caller, actor: { ...profile.actor, principalId: 'foreign' } }), /a2a_caller_denied/);
  const handler = await profile.openA2aHandler(caller);
  const reply = await handler.handle('1.0', { jsonrpc: '2.0', id: 'registration-probe', method: 'Unsupported', params: {} });
  assert.ok('error' in reply); assert.equal(reply.error.code, -32601);
  assert.equal(f.entry.observed.modelInputs.length, 0); assert.equal(f.entry.observed.reads, 0);
  const closing = profile.close(); assert.equal(profile.close(), closing); await bounded(closing);
  await assert.rejects(handler.handle('1.0', { jsonrpc: '2.0', id: 'closed', method: 'Unsupported', params: {} }));
  await assert.rejects(profile.openA2aHandler(caller), /agent_a2a_inbound_registration_required/);
  await handler.close(); assert.equal(f.entry.observed.modelCloses, 1); assert.equal(f.entry.observed.toolCloses, 1);
});

test('A2A registration: default get and explicit send cancel grants still require the current execution actor and policy', async t => {
  for (const allowWrites of [undefined, true]) {
    const f = a2aRegistrationFixture(t), probe = a2aRegistrationProbe(allowWrites);
    const profile = f.track(await openAgentTurnProfile(f.directory, { provider: 'registered' }, { ...f.entry.host, a2a: probe.registration }));
    const operations = allowWrites ? ['get', 'send', 'cancel'] as const : ['get'] as const;
    assert.equal(profile.policy.allowWrites, allowWrites === true); assert.equal(profile.actor.allowWrites, allowWrites === true);
    assert.deepEqual(profile.contracts.visible(profile.policy).filter(value => value.provider === A2A_REGISTRATION_ID).map(value => value.id).sort(),
      operations.map(value => `${A2A_REGISTRATION_ID}.${value}`).sort());
    if (!allowWrites) for (const operation of ['send', 'cancel'] as const) assert.equal(profile.contracts.get(a2aTask(operation).toolId, '1.0'), undefined);
    const get = profile.contracts.get(a2aTask('get').toolId, '1.0')!.tool;
    const denied: Policy[] = [{ ...profile.policy, tenantId: 'foreign' }, { ...profile.policy, principalId: 'foreign' },
      { ...profile.policy, allowedTools: [] }, { ...profile.policy, allowedLabels: [] }, { ...profile.policy, allowedDestinations: [] }];
    for (const policy of denied) await assert.rejects(get.execute(a2aTask('get'), a2aInvocation(policy)), /a2a_access_denied/);
    const revoked = new Error('current_execution_revoked');
    await assert.rejects(get.execute(a2aTask('get'), a2aInvocation(profile.policy, async () => { throw revoked; })), error => error === revoked);
    assert.equal(probe.counts.gets, 0);
    for (const operation of operations) {
      const task = a2aTask(operation), tool = profile.contracts.get(task.toolId, '1.0')!.tool;
      assert.equal(profile.contracts.checkExecution(task, profile.policy), null);
      if (operation !== 'get') {
        const narrowed = { ...profile.policy, allowWrites: false };
        assert.equal(profile.contracts.checkExecution(task, narrowed), 'tool_permission_denied');
        await assert.rejects(tool.execute(task, a2aInvocation(narrowed)), /a2a_access_denied/);
      }
      const result = await tool.execute(task, a2aInvocation(profile.policy));
      assert.equal(result.status, 'success'); assert.equal(result.effectState, operation === 'get' ? 'none' : 'confirmed');
      assert.deepEqual(result.evidence, []); assert.deepEqual(result.artifacts, []);
    }
    assert.deepEqual([probe.counts.gets, probe.counts.sends, probe.counts.cancels], allowWrites ? [1, 1, 1] : [1, 0, 0]);
    if (allowWrites) {
      const sent = probe.calls.find(value => value.operation === 'send')!;
      assert.equal(sent.message?.role, 'ROLE_USER'); assert.equal(sent.message?.messageId, sent.call.requestId);
      assert.match(sent.call.requestId, /^[a-f0-9]{64}$/);
      assert.equal(new Set(probe.calls.map(value => value.call.requestId)).size, 3);
    }
    assert.equal(f.entry.observed.modelInputs.length, 0); await profile.close(); await profile.close();
    assert.equal(probe.counts.closes, 1); assert.equal(probe.counts.peerCloses, 1);
  }
});

test('A2A registration: actor metadata open and provider methods are captured once with their original receivers', { timeout: 10000 }, async t => {
  const f = a2aRegistrationFixture(t), probe = a2aRegistrationProbe(true); let selections = 0;
  const originalOpen = probe.registration.open;
  Object.defineProperty(probe.registration, 'open', { configurable: true, get() { selections++; return originalOpen; } });
  const opened = await openHostA2a(probe.registration, f.context); assert.ok(opened); f.track(opened);
  assert.equal(selections, 1); assert.equal(probe.counts.opens, 1);
  assert.equal(Object.isFrozen(probe.contexts[0]), true); assert.equal(Object.isFrozen(probe.contexts[0]!.actor), true);
  assert.notEqual(probe.contexts[0]!.actor, f.context.actor); assert.equal(Object.isFrozen(opened.peer.labels), true);
  const invocationPolicy: Policy = { ...f.policy, allowedLabels: [...f.policy.allowedLabels], allowedTools: [...opened.allowedTools], allowWrites: true };
  probe.labels.push('not-granted'); f.policy.principalId = 'mutated-input-actor';
  Reflect.set(probe.peer, 'id', 'replacement'); Reflect.set(probe.peer, 'destination', 'foreign');
  Reflect.set(probe.registration, 'allowWrites', false);
  probe.peer.get = async () => { assert.fail('replacement get'); };
  probe.peer.send = async () => { assert.fail('replacement send'); };
  probe.lease.close = async () => { assert.fail('replacement close'); };
  const result = await opened.tools[0]!.execute(a2aTask('get'), a2aInvocation(invocationPolicy));
  assert.equal(result.status, 'success'); assert.equal(probe.counts.gets, 1);
  assert.equal(opened.peer.id, A2A_REGISTRATION_ID); assert.equal(opened.peer.destination, 'local');
  assert.deepEqual(opened.peer.labels, ['internal']);
  assert.deepEqual(opened.allowedTools, ['get', 'send', 'cancel'].map(operation => `${A2A_REGISTRATION_ID}.${operation}`));
  assert.equal(opened.allowWrites, true);
  const entered = gate(), release = gate();
  const message: A2aMessage = { messageId: 'fixed-message', role: 'ROLE_USER', parts: [{ text: 'Original before authorization.' }], metadata: { purpose: 'original' } };
  const original = structuredClone(message);
  const sending = opened.peer.send(message, { requestId: 'fixed-request', signal: new AbortController().signal,
    authorize: async () => { entered.release(); await release.promise; } });
  try {
    await bounded(entered.promise); assert.equal(probe.counts.sends, 0);
    const part = message.parts[0]!; assert.ok('text' in part); part.text = 'Changed during authorization.';
    message.metadata!['purpose'] = 'changed'; message.messageId = 'changed-message';
    release.release(); await bounded(sending);
    const sent = probe.calls.find(value => value.operation === 'send'); assert.ok(sent);
    assert.deepEqual(sent.message, original); assert.equal(sent.call.requestId, 'fixed-request'); assert.equal(probe.counts.sends, 1);
  } finally { release.release(); await bounded(sending); }
  const closing = opened.close(); assert.equal(opened.close(), closing); await closing;
  assert.equal(probe.counts.closes, 1); assert.equal(probe.counts.peerCloses, 1);
});

test('A2A registration: failed opens preserve their error and invalid acquired registrations close once including cleanup errors', async t => {
  const f = a2aRegistrationFixture(t), failed = a2aRegistrationProbe(), failure = new Error('source_open_failed');
  failed.controls.openError = failure;
  await assert.rejects(openAgentTurnProfile(f.directory, { provider: 'registered' }, { ...f.entry.host, a2a: failed.registration }), error => error === failure);
  assert.equal(failed.counts.opens, 1); assert.equal(failed.counts.closes, 0);
  assert.equal(f.entry.observed.toolCloses, 1); assert.equal(f.entry.observed.modelCloses, 0);
  for (const invalid of ['label', 'destination', 'protocol', 'method'] as const) {
    const probe = a2aRegistrationProbe();
    if (invalid === 'label') probe.labels.push('private');
    if (invalid === 'destination') Reflect.set(probe.peer, 'destination', 'ungranted');
    if (invalid === 'protocol') Reflect.set(probe.peer, 'protocolVersion', '2.0');
    if (invalid === 'method') Reflect.set(probe.peer, 'get', undefined);
    await assert.rejects(openHostA2a(probe.registration, f.context), /a2a_registration_invalid/);
    assert.equal(probe.counts.closes, 1); assert.equal(probe.counts.peerCloses, 1); assert.equal(probe.calls.length, 0);
  }
  const invalid = a2aRegistrationProbe(), cleanup = new Error('source_cleanup_failed');
  invalid.controls.closeError = cleanup; Reflect.set(invalid.peer, 'id', 'core');
  await assert.rejects(openHostA2a(invalid.registration, f.context), error => {
    const errors = errorLeaves(error); assert.equal(errors.length, 2);
    assert.ok(errors.some(value => value instanceof Error && value.message === 'a2a_registration_invalid'));
    assert.ok(errors.includes(cleanup)); return true;
  });
  assert.equal(invalid.counts.closes, 1);
  const unopened = a2aRegistrationProbe();
  await assert.rejects(openHostA2a({ ...unopened.registration, allowWrites: 'yes' } as unknown as HostA2aRegistration, f.context), /a2a_registration_invalid/);
  assert.equal(unopened.counts.opens, 0);
});

test('A2A registration: cancellation while the source is opening cleans the acquired lease and returns no live capability', { timeout: 10000 }, async t => {
  const f = a2aRegistrationFixture(t), probe = a2aRegistrationProbe(), entered = gate(), release = gate();
  probe.controls.beforeOpen = async () => { entered.release(); await release.promise; };
  const reason = new Error('opening_cancelled'), opening = openHostA2a(probe.registration, f.context).then(value => ({ value }), error => ({ error }));
  try {
    await bounded(entered.promise); f.controller.abort(reason); release.release();
    const result = await bounded(opening); assert.ok('error' in result); assert.equal(result.error, reason);
    assert.equal(probe.contexts[0]!.signal.aborted, true); assert.equal(probe.counts.closes, 1); assert.equal(probe.counts.peerCloses, 1);
    assert.equal(probe.calls.length, 0);
  } finally { release.release(); await bounded(opening); }
});

test('A2A registration: close fences tool entries and late reads while preserving a returned write acknowledgement', { timeout: 10000 }, async t => {
  const f = a2aRegistrationFixture(t), probe = a2aRegistrationProbe(true), entered = gate(), reply = gate(), cleanup = gate();
  const opened = await openHostA2a(probe.registration, f.context); assert.ok(opened); f.track(opened);
  const policy = { ...f.policy, allowedTools: [...opened.allowedTools], allowWrites: true };
  let started = 0;
  probe.controls.beforeCall = async () => { if (++started === 2) entered.release(); await reply.promise; };
  probe.controls.beforeClose = () => cleanup.promise;
  const get = opened.tools.find(value => value.definition.id.endsWith('.get'))!, send = opened.tools.find(value => value.definition.id.endsWith('.send'))!;
  const read = get.execute(a2aTask('get'), a2aInvocation(policy)).then(value => ({ value }), error => ({ error }));
  const write = send.execute(a2aTask('send'), a2aInvocation(policy)).then(value => ({ value }), error => ({ error }));
  let closing: Promise<void> | undefined;
  try {
    await bounded(entered.promise); closing = opened.close(); assert.equal(opened.close(), closing);
    assert.ok(probe.calls.every(value => value.call.signal.aborted));
    await assert.rejects(get.execute(a2aTask('get'), a2aInvocation(policy)));
    await assert.rejects(send.execute(a2aTask('send'), a2aInvocation(policy)));
    assert.deepEqual([probe.counts.gets, probe.counts.sends], [1, 1]);
    reply.release(); const [readResult, writeResult] = await bounded(Promise.all([read, write]));
    assert.ok('error' in readResult); assert.ok('value' in writeResult);
    assert.equal(writeResult.value.status, 'success'); assert.equal(writeResult.value.effectState, 'confirmed');
    assert.deepEqual(writeResult.value.evidence, []); assert.deepEqual(writeResult.value.artifacts, []);
    cleanup.release(); await bounded(closing); assert.equal(probe.counts.closes, 1); assert.equal(probe.counts.peerCloses, 1);
  } finally { reply.release(); cleanup.release(); await bounded(Promise.all([read, write, closing])); }
});

test('A2A registration: retained peer and mission source cannot start callbacks after the registered host closes', { timeout: 10000 }, async t => {
  const f = a2aRegistrationFixture(t), probe = a2aRegistrationProbe();
  const opened = await openHostA2a(probe.registration, f.context); assert.ok(opened); f.track(opened);
  await opened.close(); const before = probe.calls.length;
  const fresh = new AbortController().signal;
  const results = await bounded(Promise.allSettled([
    opened.peer.get('remote-task', { requestId: 'late-peer', signal: fresh }),
    opened.sources[0]!.poll({ resourceId: 'remote-task', cursor: 0, snapshotDigest: null, now: 1000, signal: fresh, authorize: async () => {} }),
  ]));
  assert.deepEqual(results.map(value => value.status), ['rejected', 'rejected']);
  assert.equal(probe.calls.length, before); assert.equal(probe.counts.closes, 1); assert.equal(probe.counts.peerCloses, 1);
});

test('A2A registration: wrong task IDs in custom get and cancel replies cannot be accepted for the original request', async t => {
  const f = a2aRegistrationFixture(t), probe = a2aRegistrationProbe(true);
  const originalGet = probe.peer.get, originalCancel = probe.peer.cancel;
  probe.peer.get = async function (taskId, call) { return { ...await originalGet.call(this, taskId, call), id: 'another-task' }; };
  probe.peer.cancel = async function (taskId, call) { return { ...await originalCancel.call(this, taskId, call), id: 'another-task' }; };
  const opened = await openHostA2a(probe.registration, f.context); assert.ok(opened); f.track(opened);
  const requestedId = 'original-task', signal = new AbortController().signal;
  const results = await Promise.allSettled([
    opened.peer.get(requestedId, { requestId: 'get-original', signal }),
    opened.peer.cancel(requestedId, { requestId: 'cancel-original', signal }),
  ]);
  assert.deepEqual(probe.calls.map(value => ({ operation: value.operation, taskId: value.taskId })),
    [{ operation: 'get', taskId: requestedId }, { operation: 'cancel', taskId: requestedId }]);
  assert.deepEqual([probe.counts.gets, probe.counts.cancels, probe.counts.sends], [1, 1, 0]);
  assert.deepEqual(results.map(value => value.status), ['rejected', 'rejected'], 'schema-valid replies still belong to a different task');
  assert.equal(f.entry.observed.modelInputs.length, 0); assert.equal(f.entry.observed.reads, 0);
});
