import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MissionEventSource } from '../application/mission-contracts.js';
import type { TaskSpec } from '../domain/model.js';
import type { HostMissionAssembly, HostMissionContext, HostMissionRegistration } from '../presentation/host-missions.js';
import { openAgentTurnProfile, type AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { collaborationRegistrationFixture } from './host-collaboration-registration-fixture.js';

export type MissionPoll = Parameters<MissionEventSource['poll']>[0];
export function missionPoll(changes: Partial<MissionPoll> = {}): MissionPoll {
  return { resourceId: 'observed-resource', cursor: 0, snapshotDigest: null, now: 1000,
    signal: new AbortController().signal, authorize: async () => {}, ...changes };
}
export function missionGate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
export async function missionBounded<T>(value: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([value, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('mission_fixture_wait_timeout')), 3000);
  })]); } finally { if (timer !== undefined) clearTimeout(timer); }
}

export function missionRegistrationFixture(t: TestContext, enabled = true) {
  const fixture = collaborationRegistrationFixture(t), path = join(fixture.directory, 'config.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, features: { ...config.features, missions: enabled } }), { mode: 0o600 });
  const context: HostMissionContext = { ...fixture.archiveContext };
  return { ...fixture, context,
    async open(registration: HostMissionRegistration) {
      return fixture.track(await openAgentTurnProfile(fixture.directory, { provider: 'registered' }, { ...fixture.entry.host, missions: registration }));
    } };
}

/** Raw host port deliberately has no wrapper authorization or lifetime checks. */
export function missionRegistrationProbe() {
  const counts = { opens: 0, polls: 0, closes: 0 }, contexts: HostMissionContext[] = [], assemblies: HostMissionAssembly[] = [], requests: MissionPoll[] = [];
  const controls: { openError?: Error; closeError?: Error; beforeOpen?: () => Promise<void>; beforePoll?: () => Promise<void>; beforeClose?: () => Promise<void> } = {};
  const labels = ['internal'];
  const source: MissionEventSource = { id: 'observations', destination: 'local', labels,
    async poll(request) {
      assert.equal(this, source); counts.polls++; requests.push(request); await controls.beforePoll?.();
      return { cursor: request.cursor + 1, snapshotDigest: 'original-snapshot', events: [{ id: 'observed-event', kind: 'observation',
        referenceId: request.resourceId, occurredAt: request.now, body: { text: 'Original unreviewed observation.' } }] };
    } };
  const sources: MissionEventSource[] = [source];
  const lease = { sources, async close() { assert.equal(this, lease); counts.closes++; await controls.beforeClose?.(); if (controls.closeError) throw controls.closeError; } };
  const registration: HostMissionRegistration = { async open(context, assembly) {
    assert.equal(this, registration); counts.opens++; contexts.push(context); assemblies.push(assembly);
    await controls.beforeOpen?.(); if (controls.openError) throw controls.openError; return lease;
  } };
  return { registration, lease, source, sources, labels, contexts, assemblies, requests, controls, counts };
}
export function missionTask(): TaskSpec {
  return { id: 'mission-list', description: 'Read registered mission rules without running a mission.', toolId: 'mission.events', toolVersion: '1',
    effect: 'read', input: { maxBytes: 512 }, dependsOn: [], satisfies: [], maxAttempts: 1 };
}
export async function acceptMissionWork(profile: AgentTurnProfile) {
  const session = await profile.sessions.open(profile.actor, { channel: 'test', conversationId: 'mission-registration' });
  return profile.turns.accept(profile.actor, { sessionId: session.scope.sessionId, messageId: 'mission-original', rawText: 'Keep this original request without starting a model.',
    binding: { ...profile.executionActor, channel: 'test', conversationId: 'mission-registration', recipientId: profile.actor.principalId, destination: 'local' },
    scope: profile.scope, mode: 'auto', policy: profile.policy, limits: profile.limits });
}
