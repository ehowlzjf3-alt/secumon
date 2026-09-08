import test from 'node:test';
import assert from 'node:assert/strict';
import { PEER_TOOL_IDS } from '../application/peer-agents.js';
import { BUDGET_TOOL_IDS } from '../application/budget-tools.js';
import type { PeerAgent } from '../application/peer-contracts.js';
import { openAgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { openRegisteredHostPeers, resolveHostPeerRegistration } from '../presentation/host-peers.js';
import { collaborationRegistrationFixture } from './host-collaboration-registration-fixture.js';
import { HOST_ENTRY_TEXT } from './host-tool-entry-fixture.js';
import { deferred, signal } from './peer-service-fixture.js';
import { peerRegistrationProbe, registrationRequest, setPeersFeature } from './host-peer-registration-fixture.js';

test('peer registration: disabled selection is never read and the generic session remains usable', async t => {
  const f = collaborationRegistrationFixture(t); setPeersFeature(f.directory, false); let selections = 0;
  const host = { ...f.entry.host, get peers(): never { selections++; throw new Error('disabled_peer_selected'); } };
  const profile = f.track(await openAgentTurnProfile(f.directory, { provider: 'registered' }, host));
  assert.equal(profile.peers, null);
  for (const id of [...PEER_TOOL_IDS, ...BUDGET_TOOL_IDS]) assert.equal(profile.contracts.get(id, '1'), undefined);
  const session = await profile.sessions.open(profile.actor, { channel: 'test', conversationId: 'peers-off' });
  const accepted = await profile.turns.accept(profile.actor, { sessionId: session.scope.sessionId, messageId: 'normal-request', rawText: HOST_ENTRY_TEXT,
    binding: { ...profile.executionActor, channel: 'test', conversationId: 'peers-off', recipientId: profile.actor.principalId, destination: 'local' },
    scope: profile.scope, mode: 'auto', policy: profile.policy, limits: profile.limits });
  assert.equal((await profile.workflow.run(accepted.workId, profile.executionActor)).control.kind, 'complete');
  assert.equal(selections, 0); assert.equal(f.entry.observed.reads, 1);
  assert.ok(f.entry.observed.modelInputs.every(input => input.packet.activeToolIds.every(id => !id.startsWith('core.peer.') && !id.startsWith('core.budget.'))));
  assert.equal((await profile.sessions.history(profile.actor, session.scope.sessionId, profile.policy, { limit: 100 })).entries.filter(item => item.kind === 'result').length, 1);
});

test('peer registration: enabled profile requires a registration and exposes only selected peer operations', async t => {
  const f = collaborationRegistrationFixture(t); setPeersFeature(f.directory, true);
  await assert.rejects(openAgentTurnProfile(f.directory, { provider: 'registered' }, f.entry.host), /agent_peer_registration_required/);
  assert.equal(f.entry.observed.toolContexts.length, 0); assert.equal(f.entry.observed.modelInputs.length, 0);
  const probe = peerRegistrationProbe(); probe.allowedTools.splice(1);
  const profile = f.track(await openAgentTurnProfile(f.directory, { provider: 'registered' }, { ...f.entry.host, peers: probe.registration }));
  assert.ok(profile.peers); assert.equal(profile.policy.allowWrites, false);
  assert.deepEqual(profile.contracts.visible(profile.policy).filter(item => item.id.startsWith('core.peer.')).map(item => item.id), [PEER_TOOL_IDS[0]]);
  assert.equal(profile.policy.allowedTools.includes(PEER_TOOL_IDS[1]), false);
  assert.equal(probe.observed.requests.length, 0); assert.equal(probe.observed.runs.length, 0);
  await profile.close(); assert.equal(probe.counts.closes, 1); assert.equal(f.entry.observed.modelCloses, 1); assert.equal(f.entry.observed.toolCloses, 1);
});

test('peer registration: metadata and callbacks are captured once while source object mutation cannot change the opened registry', async t => {
  const f = collaborationRegistrationFixture(t), probe = peerRegistrationProbe();
  const originalOpen = probe.registration.open; let selections = 0;
  Object.defineProperty(probe.registration, 'open', { configurable: true, get() { selections++; return originalOpen; } });
  const selected = resolveHostPeerRegistration({ peers: probe.registration }); assert.ok(selected);
  Object.defineProperty(probe.registration, 'open', { value: async () => { assert.fail('replacement factory'); } });
  const opened = f.track(await openRegisteredHostPeers(selected, f.context)), peer = opened.peers.get('reviewer')!;
  const identity = structuredClone(peer.identity), request = registrationRequest(f.context);
  assert.equal(selections, 1); assert.equal(Object.isFrozen(probe.contexts[0]), true); assert.equal(Object.isFrozen(probe.contexts[0]!.policy), true);
  probe.identity.agentId = 'changed-agent'; probe.identity.model.revision = 'changed-model';
  (probe.peer.allowedLabels as string[]).push('later-secret'); probe.allowedTools.length = 0; probe.peers.clear();
  probe.peer.request = async () => { assert.fail('replacement request'); };
  probe.peer.run = async () => { assert.fail('replacement run'); };
  probe.peer.current = async () => { assert.fail('replacement current'); };
  probe.lease.close = async () => { assert.fail('replacement close'); };
  assert.deepEqual(peer.identity, identity); assert.equal(peer.allowedLabels.includes('later-secret'), false);
  assert.deepEqual(opened.allowedTools, [...PEER_TOOL_IDS]); assert.equal(opened.peers.size, 1);
  const ticket = await peer.request(request, signal()), reply = await peer.run(request, ticket, signal());
  assert.equal(await peer.current(request, reply), true);
  assert.equal(probe.observed.requests.length, 1); assert.equal(probe.observed.runs.length, 1); assert.equal(probe.observed.checks, 1);
  const closing = opened.close(); assert.equal(opened.close(), closing); await closing; assert.equal(probe.counts.closes, 1);
});

test('peer registration: close immediately rejects new calls and a delayed in-flight reply even while provider cleanup waits', { timeout: 15000 }, async t => {
  const f = collaborationRegistrationFixture(t), probe = peerRegistrationProbe(), entered = deferred(), replyRelease = deferred(), closeRelease = deferred();
  t.after(() => { replyRelease.resolve(); closeRelease.resolve(); });
  probe.controls.beforeRun = async () => { entered.resolve(); await replyRelease.promise; };
  probe.lifecycle.beforeClose = () => closeRelease.promise;
  const opened = f.track(await openRegisteredHostPeers(probe.registration, f.context)), peer = opened.peers.get('reviewer')!, request = registrationRequest(f.context);
  const ticket = await peer.request(request, signal()), running = peer.run(request, ticket, signal());
  const rejected = assert.rejects(running, /peer_unavailable/); await entered.promise;
  const closing = opened.close(); assert.equal(opened.close(), closing);
  await assert.rejects(peer.request(request, signal()), /peer_unavailable/);
  await assert.rejects(peer.run(request, ticket, signal()), /peer_unavailable/);
  replyRelease.resolve(); await rejected; closeRelease.resolve(); await closing;
  assert.equal(probe.counts.closes, 1); assert.equal(probe.observed.requests.length, 1); assert.equal(probe.observed.runs.length, 1);
});

test('peer registration: cancelled acquisition and a malformed later peer release the acquired provider exactly once', async t => {
  for (const fault of ['cancelled', 'second-peer', 'self-peer', 'duplicate-tools'] as const) {
    const f = collaborationRegistrationFixture(t), probe = peerRegistrationProbe();
    if (fault === 'cancelled') probe.lifecycle.beforeOpen = async () => { f.controller.abort(); };
    if (fault === 'second-peer') probe.peers.set('broken', { ...probe.peer, run: undefined } as unknown as PeerAgent);
    if (fault === 'self-peer') probe.identity.agentId = f.context.agentId;
    if (fault === 'duplicate-tools') probe.allowedTools[1] = PEER_TOOL_IDS[0];
    await assert.rejects(openRegisteredHostPeers(probe.registration, f.context), fault === 'cancelled' ? /peer_unavailable/ : /peer_registration_invalid/);
    assert.equal(probe.counts.opens, 1); assert.equal(probe.counts.closes, 1);
    assert.equal(probe.observed.requests.length, 0); assert.equal(probe.observed.runs.length, 0);
  }
});

test('peer registration: caller abort prevents callbacks and a later profile failure closes already opened peer resources', async t => {
  const f = collaborationRegistrationFixture(t), probe = peerRegistrationProbe();
  const opened = f.track(await openRegisteredHostPeers(probe.registration, f.context)), peer = opened.peers.get('reviewer')!;
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(peer.request(registrationRequest(f.context), aborted.signal), /peer_unavailable/); assert.equal(probe.observed.requests.length, 0);
  await opened.close();
  const next = collaborationRegistrationFixture(t); setPeersFeature(next.directory, true); const acquired = peerRegistrationProbe();
  const model = next.entry.host.models!.get('host-entry-v1')!;
  const host = { ...next.entry.host, peers: acquired.registration, models: new Map([['host-entry-v1', { ...model,
    async open() { throw new Error('model_open_failed_after_peers'); } }]]) };
  await assert.rejects(openAgentTurnProfile(next.directory, { provider: 'registered' }, host), /model_open_failed_after_peers/);
  assert.equal(acquired.counts.opens, 1); assert.equal(acquired.counts.closes, 1);
  assert.equal(next.entry.observed.toolCloses, 1); assert.equal(acquired.observed.requests.length, 0);
});
