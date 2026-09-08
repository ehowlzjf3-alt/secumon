import test from 'node:test';
import assert from 'node:assert/strict';
import type { Policy } from '../domain/model.js';
import { openHostMissions, createScheduledMissionRegistration } from '../presentation/host-missions.js';
import { openAgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { errorLeaves } from './host-tool-profile-helper.js';
import { acceptMissionWork, missionBounded, missionGate, missionPoll, missionRegistrationFixture, missionRegistrationProbe, missionTask } from './host-missions-registration-fixture.js';

test('mission registration: off never selects the host and on requires explicit registration without starting work', async t => {
  const f = missionRegistrationFixture(t, false); let selections = 0;
  const profile = f.track(await openAgentTurnProfile(f.directory, { provider: 'registered' }, { ...f.entry.host,
    get missions(): never { selections++; throw new Error('disabled_missions_selected'); } }));
  assert.equal(profile.missions, null); assert.deepEqual(profile.missionSources, []); assert.equal(profile.contracts.get('mission.events', '1'), undefined);
  const original = await acceptMissionWork(profile), state = await profile.runtime.state(original.workId);
  assert.equal(state.goal.description, 'Keep this original request without starting a model.');
  assert.equal(state.modelCalls.length, 0); assert.equal(state.attempts.length, 0); assert.equal(selections, 0);
  const extra = missionRegistrationProbe();
  assert.equal(await openHostMissions(undefined, f.context, { services: profile.services }, extra.sources), null);
  assert.equal(extra.counts.opens, 0); assert.equal(extra.counts.polls, 0);
  const enabled = missionRegistrationFixture(t, true);
  await assert.rejects(openAgentTurnProfile(enabled.directory, { provider: 'registered' }, enabled.entry.host), /agent_mission_registration_required/);
  assert.equal(enabled.entry.observed.toolContexts.length, 0); assert.equal(enabled.entry.observed.modelCloses, 0);
});

test('mission registration: enabled read-only events tool checks the current invocation identity policy and authority', async t => {
  const f = missionRegistrationFixture(t), probe = missionRegistrationProbe(), profile = await f.open(probe.registration);
  assert.ok(profile.missions); assert.equal(profile.policy.allowWrites, false); assert.equal(profile.actor.allowWrites, false);
  const entry = profile.contracts.get('mission.events', '1'); assert.ok(entry);
  assert.deepEqual(profile.contracts.visible(profile.policy).filter(value => value.provider === 'mission').map(value => [value.id, value.effect]), [['mission.events', 'read']]);
  const accepted = await acceptMissionWork(profile), original = await profile.runtime.state(accepted.workId);
  const invocation = { workId: accepted.workId, attemptId: 'mission-list-attempt', policy: profile.policy, signal: new AbortController().signal };
  const result = await entry.tool.execute(missionTask(), invocation);
  assert.equal(result.status, 'success'); assert.equal(result.effectState, 'none'); assert.deepEqual(result.output, { kind: 'mission_rules', rules: [] });
  assert.deepEqual(result.evidence, []); assert.deepEqual(result.artifacts, []);
  const denied: Policy[] = [{ ...profile.policy, tenantId: 'foreign' }, { ...profile.policy, principalId: 'foreign' },
    { ...profile.policy, allowedTools: [] }, { ...profile.policy, allowedLabels: [] }, { ...profile.policy, allowedDestinations: [] }];
  const results = await Promise.allSettled(denied.map(policy => entry.tool.execute(missionTask(), { ...invocation, policy })));
  assert.deepEqual(results.map(value => value.status), denied.map(() => 'rejected'));
  const denial = new Error('current_mission_execution_revoked');
  await assert.rejects(entry.tool.execute(missionTask(), { ...invocation, authorize: async () => { throw denial; } }), error => error === denial);
  assert.deepEqual(await profile.runtime.state(accepted.workId), original);
  assert.equal(probe.counts.polls, 0); assert.equal(f.entry.observed.modelInputs.length, 0); assert.equal(f.entry.observed.reads, 0);
  await profile.close(); assert.equal(probe.counts.closes, 1);
});

test('mission registration: source metadata callback receivers assembly and scheduled options are captured without merging stores', async t => {
  const f = missionRegistrationFixture(t, false), profile = f.track(await openAgentTurnProfile(f.directory, { provider: 'registered' }, f.entry.host));
  const probe = missionRegistrationProbe(), originalOpen = probe.registration.open; let selections = 0;
  Object.defineProperty(probe.registration, 'open', { configurable: true, get() { selections++; return originalOpen; } });
  const opened = await openHostMissions(probe.registration, f.context, { services: profile.services }); assert.ok(opened); f.track(opened);
  assert.equal(selections, 1); assert.equal(probe.assemblies[0]!.services, profile.services);
  assert.equal(Object.isFrozen(probe.contexts[0]), true); assert.equal(Object.isFrozen(probe.contexts[0]!.actor), true);
  assert.notEqual(probe.contexts[0]!.actor, f.context.actor); assert.equal(Object.isFrozen(probe.assemblies[0]), true);
  assert.deepEqual(opened.allowedTools, ['mission.events']); assert.equal(opened.allowWrites, false);
  probe.labels.push('later-private'); probe.sources.length = 0; Reflect.set(probe.source, 'id', 'replacement');
  probe.source.poll = async () => { assert.fail('replacement poll'); }; probe.lease.close = async () => { assert.fail('replacement close'); };
  assert.equal(opened.sources.length, 1); assert.equal(opened.sources[0]!.id, 'observations');
  assert.deepEqual(opened.sources[0]!.labels, ['internal']); assert.equal(Object.isFrozen(opened.sources[0]!.labels), true);
  const page = await opened.sources[0]!.poll(missionPoll());
  assert.equal(page.events[0]!.referenceId, 'observed-resource'); assert.equal(probe.counts.polls, 1);
  const closing = opened.close(); assert.equal(opened.close(), closing); await closing; assert.equal(probe.counts.closes, 1);
  const schedules = [{ id: 'timer', resourceId: 'observed-resource', firstAt: 1000, intervalMs: 1000 }];
  const registration = createScheduledMissionRegistration(schedules); schedules[0]!.firstAt = 999999;
  const timer = await openHostMissions(registration, f.context, { services: profile.services }); assert.ok(timer); f.track(timer);
  assert.equal((await timer.sources[0]!.poll(missionPoll({ now: 1000 }))).events[0]!.occurredAt, 1000);
  assert.equal(profile.services.state, probe.assemblies[0]!.services.state); assert.equal(f.entry.observed.modelInputs.length, 0);
});

test('mission registration: raw exported sources enforce current authorization and caller cancellation before invoking the host', async t => {
  const f = missionRegistrationFixture(t), probe = missionRegistrationProbe(), profile = await f.open(probe.registration);
  const raw = profile.missionSources[0]!, denial = new Error('mission_source_current_authority_denied'), stopped = new AbortController();
  stopped.abort(denial); let checks = 0;
  const results = await Promise.allSettled([
    raw.poll(missionPoll({ authorize: async () => { checks++; throw denial; } })),
    raw.poll(missionPoll({ signal: stopped.signal, authorize: async () => { checks++; } })),
  ]);
  assert.deepEqual(results.map(value => value.status), ['rejected', 'rejected']);
  assert.equal(checks, 1); assert.equal(probe.counts.polls, 0); assert.equal(f.entry.observed.modelInputs.length, 0);
});

test('mission registration: closing rejects retained raw sources and tools plus late in-flight results and closes one lease', { timeout: 15000 }, async t => {
  const f = missionRegistrationFixture(t), probe = missionRegistrationProbe(), profile = await f.open(probe.registration);
  const accepted = await acceptMissionWork(profile), raw = profile.missionSources[0]!, tool = profile.contracts.get('mission.events', '1')!.tool;
  const sourceEntered = missionGate(), toolEntered = missionGate(), release = missionGate();
  probe.controls.beforePoll = async () => { sourceEntered.release(); await release.promise; };
  const invocation = { workId: accepted.workId, attemptId: 'held-mission-list', policy: profile.policy, signal: new AbortController().signal,
    authorize: async () => { toolEntered.release(); await release.promise; } };
  const polling = raw.poll(missionPoll()).then(value => ({ value }), error => ({ error }));
  const reading = tool.execute(missionTask(), invocation).then(value => ({ value }), error => ({ error }));
  let closing: Promise<void> | undefined;
  try {
    await missionBounded(Promise.all([sourceEntered.promise, toolEntered.promise]));
    closing = profile.close(); assert.equal(profile.close(), closing);
    const late = Promise.allSettled([raw.poll(missionPoll()), tool.execute(missionTask(), { ...invocation, authorize: async () => {} })]);
    release.release(); const [pollResult, toolResult, lateResults] = await missionBounded(Promise.all([polling, reading, late]));
    await missionBounded(closing);
    assert.ok('error' in pollResult); assert.ok('error' in toolResult); assert.deepEqual(lateResults.map(value => value.status), ['rejected', 'rejected']);
    assert.equal(probe.counts.polls, 1); assert.equal(probe.counts.closes, 1); assert.equal(f.entry.observed.toolCloses, 1); assert.equal(f.entry.observed.modelCloses, 1);
    assert.equal(f.entry.observed.modelInputs.length, 0);
  } finally { release.release(); await missionBounded(Promise.all([polling, reading, closing])); }
});

test('mission registration: duplicate sources failed opens and interrupted registration preserve errors and clean acquired leases', { timeout: 15000 }, async t => {
  const f = missionRegistrationFixture(t, false), profile = f.track(await openAgentTurnProfile(f.directory, { provider: 'registered' }, f.entry.host));
  const assembly = { services: profile.services }, failed = missionRegistrationProbe(), openError = new Error('mission_source_open_failed');
  failed.controls.openError = openError;
  await assert.rejects(openHostMissions(failed.registration, f.context, assembly), error => error === openError);
  assert.equal(failed.counts.closes, 0);
  const duplicate = missionRegistrationProbe();
  await assert.rejects(openHostMissions(duplicate.registration, f.context, assembly, duplicate.sources), /mission_source_invalid/);
  assert.equal(duplicate.counts.closes, 1); assert.equal(duplicate.counts.polls, 0);
  const invalid = missionRegistrationProbe(), closeError = new Error('mission_cleanup_failed');
  Reflect.set(invalid.source, 'poll', undefined); invalid.controls.closeError = closeError;
  await assert.rejects(openHostMissions(invalid.registration, f.context, assembly), error => {
    const leaves = errorLeaves(error); assert.equal(leaves.length, 2); assert.ok(leaves.includes(closeError));
    assert.ok(leaves.some(value => value instanceof Error && value.message === 'mission_source_invalid')); return true;
  });
  assert.equal(invalid.counts.closes, 1);
  const held = missionRegistrationProbe(), entered = missionGate(), release = missionGate(), controller = new AbortController();
  const stopped = new Error('mission_open_cancelled'); held.controls.beforeOpen = async () => { entered.release(); await release.promise; };
  const opening = openHostMissions(held.registration, { ...f.context, signal: controller.signal }, assembly).then(value => ({ value }), error => ({ error }));
  try {
    await missionBounded(entered.promise); controller.abort(stopped); release.release();
    const outcome = await missionBounded(opening); assert.ok('error' in outcome); assert.equal(outcome.error, stopped);
    assert.equal(held.counts.closes, 1); assert.equal(held.counts.polls, 0);
  } finally { release.release(); await missionBounded(opening); }
});
