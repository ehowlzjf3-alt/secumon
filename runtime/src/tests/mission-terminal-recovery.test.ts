import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { MissionEventSchema } from '../application/mission-contracts.js';
import { transact } from '../application/work-transactions.js';
import type { AgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { missionTerminalFixture } from './mission-terminal-recovery-fixture.js';

test('mission terminal recovery: one completed work closes both exact rule checkpoints and preserves their original events across reopen', { timeout: 120000 }, async t => {
  const h = await missionTerminalFixture(t), p = h.current();
  const result = await p.missions!.tick(h.workId, p.workflow, { maxSteps: 20 });
  assert.equal(result.kind, 'ran'); if (result.kind !== 'ran') return;
  assert.equal(result.result.control.kind, 'complete');
  const records = await h.records(), closed = await h.checkpoints();
  assert.equal(records.state.status, 'completed'); assert.deepEqual(records.state.notifications, []);
  assert.equal(records.state.budget.used.modelCalls, 1); assert.equal(records.state.budget.used.toolCalls, 2);
  assert.equal(records.state.obligations.find(value => value.id === 'mission-wait')?.status, 'satisfied');
  assert.deepEqual(records.state.evidence, []); assert.deepEqual(await h.f.memory('first'), []);
  for (const [index, item] of closed.entries()) {
    assert.equal(item.subscription.status, 'closed'); assert.equal(item.value.status, 'closed');
    assert.equal(item.value.claim, null); assert.equal(item.value.pendingRun, false); assert.equal(item.value.reason, 'completed');
    assert.deepEqual(item.value.events, [h.event]); assert.equal(item.value.cursor, h.original[index]!.value.cursor);
    assert.deepEqual(item.value.acknowledgedRead, h.acknowledged[index]!.value.acknowledgedRead);
  }
  await h.preserve(records); await h.f.reopen();
  assert.equal((await h.current().missions!.tick(h.workId, h.current().workflow)).kind, 'idle');
  assert.deepEqual(await h.checkpoints(), closed); await h.preserve(records, true);
});

test('mission terminal recovery: an exception after actual workflow completion is repaired on reopen without another model, tool, poll or delivery', { timeout: 120000 }, async t => {
  const h = await missionTerminalFixture(t), prior = await h.interruptAfterComplete();
  await h.f.reopen(); await h.preserve(prior, true);
  await h.current().missions!.tick(h.workId, h.current().workflow);
  const restored = await h.checkpoints();
  for (const [index, item] of restored.entries()) {
    assert.equal(item.value.status, 'closed'); assert.equal(item.subscription.status, 'closed');
    assert.equal(item.value.claim, null); assert.equal(item.value.pendingRun, false); assert.equal(item.value.reason, 'completed');
    assert.deepEqual(item.value.events, [h.event]); assert.equal(item.value.cursor, h.original[index]!.value.cursor);
    assert.deepEqual(item.value.acknowledgedRead, h.acknowledged[index]!.value.acknowledgedRead);
  }
  await h.preserve(prior);
  const stable = await h.records(); await h.f.reopen();
  assert.equal((await h.current().missions!.tick(h.workId, h.current().workflow)).kind, 'idle');
  await h.preserve(stable, true); assert.deepEqual(await h.checkpoints(), restored);
});

for (const change of ['receipt digest', 'receipt goal', 'receipt policy', 'receipt generation'] as const) {
  test(`mission terminal recovery: changed ${change} cannot close retained checkpoints or rewrite original records`, { timeout: 120000 }, async t => {
    const h = await missionTerminalFixture(t), prior = await h.interruptAfterComplete();
    await h.f.reopen(); const p = h.current(), receipt = p.services.state.receipt;
    let rejectedObservation = 0;
    p.services.state.receipt = async (workId, commandId) => {
      const value = await receipt.call(p.services.state, workId, commandId);
      if (workId !== h.workId || commandId !== prior.complete.commandId || !value) return value;
      const changed = structuredClone(value); rejectedObservation++;
      if (change === 'receipt digest') changed.digest = '0'.repeat(64);
      else if (change === 'receipt goal') changed.state.goal.revision++;
      else if (change === 'receipt policy') changed.state.policy.allowedTools = [];
      else changed.state.dataLifecycle = { ...(changed.state.dataLifecycle ?? { blockedArtifactIds: [], changes: [] }),
        generation: (changed.state.dataLifecycle?.generation ?? 0) + 1 };
      return changed;
    };
    try { await assert.rejects(p.missions!.tick(h.workId, p.workflow), /mission_state_changed|mission_access_denied/); }
    finally { p.services.state.receipt = receipt; }
    assert.ok(rejectedObservation > 0, 'recovery must inspect the actual original completion receipt');
    await h.preserve(prior, true);
  });
}

// Added after the original terminal-recovery baseline; these are correction acceptance cases, not prior passing evidence.
test('mission terminal recovery: a committed first cleanup survives interruption and reopen publishes only the remaining rule', { timeout: 120000 }, async t => {
  const h = await missionTerminalFixture(t), original = await h.interruptAfterComplete();
  await h.f.reopen(); const p = h.current(), commit = p.services.state.commit;
  const interruption = new Error('test_interrupt_after_cleanup_commit'); let publications = 0;
  p.services.state.commit = async request => {
    const result = await commit.call(p.services.state, request);
    if (request.workId === h.workId && request.next.status === 'completed' && result.kind === 'committed' &&
        request.events.some(value => value.type === 'mission_checkpoint') && ++publications === 1) throw interruption;
    return result;
  };
  try { await assert.rejects(p.missions!.tick(h.workId, p.workflow), error => error === interruption); }
  finally { p.services.state.commit = commit; }
  assert.equal(publications, 1, 'the exception follows one actual durable mission_checkpoint commit');
  const partial = await h.records(), heads = await h.checkpoints(), closed = heads.filter(value => value.value.status === 'closed');
  assert.equal(closed.length, 1); assert.equal(heads.filter(value => value.value.status === 'active').length, 1);
  assert.deepEqual(partial.events.slice(0, original.events.length), original.events); await h.preserve(original);
  await h.f.reopen(); await h.preserve(partial, true);
  await h.current().missions!.tick(h.workId, h.current().workflow);
  const restored = await h.checkpoints(), stable = await h.records();
  assert.ok(restored.every(value => value.value.status === 'closed' && value.value.claim === null && !value.value.pendingRun));
  assert.deepEqual(restored.find(value => value.subscription.id === closed[0]!.subscription.id), closed[0]);
  assert.equal(stable.events.slice(partial.events.length).filter(value => value.type === 'mission_checkpoint').length, 1);
  assert.deepEqual(stable.events.slice(0, partial.events.length), partial.events); await h.preserve(partial);
  assert.equal((await h.current().missions!.tick(h.workId, h.current().workflow)).kind, 'idle'); await h.preserve(stable, true);
});

async function extraCheckpoint(p: AgentTurnProfile, workId: string, resourceId: string) {
  const state = await p.runtime.state(workId), subscription = state.subscriptions?.find(value => value.provider === 'mission' && value.resourceId === resourceId);
  assert.ok(subscription); const artifact = state.artifacts.find(value => subscription.checkpointId === `mission:${value.sha256}`); assert.ok(artifact);
  const receipt = await p.services.state.receipt(workId, subscription.checkpointId); assert.ok(receipt);
  const bytes = await p.services.artifacts.get(artifact, state.policy);
  const value = z.object({ events: z.array(MissionEventSchema), status: z.enum(['active', 'closed']), pendingRun: z.boolean(),
    reason: z.string().nullable(), claim: z.object({ owner: z.string(), until: z.number() }).nullable() })
    .parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  return { subscription, artifact, receipt, bytes, value };
}

test('mission terminal recovery: completion closes an idle unclaimed rule while preserving a previously host-closed rule exactly', { timeout: 120000 }, async t => {
  const h = await missionTerminalFixture(t), p = h.current();
  const hostRule = { ...h.rules[0]!, id: 'previously-host-closed', resourceId: 'host-closed-resource' };
  await p.missions!.register(h.workId, hostRule); await p.missions!.refresh(h.workId);
  const hostOriginal = await extraCheckpoint(p, h.workId, hostRule.resourceId);
  assert.deepEqual(hostOriginal.value.events, [h.event]);
  await p.missions!.close(h.workId, hostRule.id); const hostClosed = await extraCheckpoint(p, h.workId, hostRule.resourceId);
  assert.equal(hostClosed.value.status, 'closed'); assert.equal(hostClosed.value.reason, 'host_closed');
  assert.equal(hostClosed.value.claim, null);
  h.f.pages.first.length = 0;
  const idleRule = { ...h.rules[0]!, id: 'idle-at-completion', resourceId: 'idle-resource' };
  await p.missions!.register(h.workId, idleRule); await p.missions!.refresh(h.workId);
  const idle = await extraCheckpoint(p, h.workId, idleRule.resourceId);
  assert.equal(idle.value.status, 'active'); assert.equal(idle.value.claim, null);
  assert.equal(idle.value.pendingRun, false); assert.deepEqual(idle.value.events, []);
  const result = await p.missions!.tick(h.workId, p.workflow, { maxSteps: 20 });
  assert.equal(result.kind, 'ran'); if (result.kind !== 'ran') return;
  assert.equal(result.result.control.kind, 'complete');
  const idleClosed = await extraCheckpoint(p, h.workId, idleRule.resourceId), records = await h.records();
  assert.equal(idleClosed.value.status, 'closed'); assert.equal(idleClosed.value.reason, 'completed');
  assert.equal(idleClosed.value.claim, null); assert.equal(idleClosed.value.pendingRun, false); assert.deepEqual(idleClosed.value.events, []);
  assert.deepEqual(await extraCheckpoint(p, h.workId, hostRule.resourceId), hostClosed);
  assert.ok((await h.checkpoints()).every(value => value.value.status === 'closed' && value.value.claim === null));
  assert.equal(records.state.budget.used.modelCalls, 1); assert.equal(records.state.budget.used.toolCalls, 2);
  await h.f.reopen(); assert.equal((await h.current().missions!.tick(h.workId, h.current().workflow)).kind, 'idle');
  assert.deepEqual(await extraCheckpoint(h.current(), h.workId, hostRule.resourceId), hostClosed);
  assert.deepEqual(await extraCheckpoint(h.current(), h.workId, idleRule.resourceId), idleClosed);
  assert.deepEqual(await h.current().services.artifacts.get(hostOriginal.artifact, records.state.policy), hostOriginal.bytes);
  assert.deepEqual(await h.current().services.state.receipt(h.workId, hostOriginal.subscription.checkpointId), hostOriginal.receipt);
  await h.preserve(records, true);
});

for (const change of ['budget', 'removed subscriptions'] as const) test(`mission terminal recovery: unrelated durable ${change} after completion cannot be accepted as checkpoint cleanup`, { timeout: 120000 }, async t => {
  const h = await missionTerminalFixture(t), original = await h.interruptAfterComplete(), p = h.current();
  // An explicit test-only repository mutation, not a real model charge or an execution permission change.
  await transact(p.services, h.workId, 'test-unrelated-after-completion', 'test_unrelated_change', {}, state => {
    if (change === 'budget') state.budget.used.tokens++;
    else state.subscriptions = state.subscriptions?.filter(value => value.provider !== 'mission');
  });
  const changed = await h.records();
  if (change === 'budget') assert.equal(changed.state.budget.used.tokens, original.state.budget.used.tokens + 1);
  else assert.ok(!changed.state.subscriptions?.some(value => value.provider === 'mission'));
  assert.deepEqual(changed.complete, original.complete);
  await h.f.reopen();
  await assert.rejects(h.current().missions!.tick(h.workId, h.current().workflow), /mission_state_changed|mission_access_denied/);
  await h.preserve(changed, true);
});

test('mission terminal recovery: two simultaneous terminal ticks both finish and commit each rule closure once', { timeout: 120000 }, async t => {
  const h = await missionTerminalFixture(t), original = await h.interruptAfterComplete();
  await h.f.reopen(); const p = h.current(), receipt = p.services.state.receipt;
  const controller = new AbortController(); let release!: () => void, arrivals = 0, timedOut = false;
  const bothRead = new Promise<void>(resolve => { release = resolve; });
  const timer = setTimeout(() => {
    timedOut = true; controller.abort(new Error('test_terminal_tick_race_timeout')); release();
  }, 15000);
  p.services.state.receipt = async (workId, commandId) => {
    const value = await receipt.call(p.services.state, workId, commandId);
    if (workId === h.workId && commandId === original.complete.commandId && arrivals < 2) {
      assert.deepEqual(value, original.complete.receipt); arrivals++;
      if (arrivals === 2) release();
      await bothRead; controller.signal.throwIfAborted();
    }
    return value;
  };
  const pending = [p.missions!.tick(h.workId, p.workflow, { signal: controller.signal }),
    p.missions!.tick(h.workId, p.workflow, { signal: controller.signal })];
  try {
    const results = await Promise.allSettled(pending);
    assert.equal(timedOut, false); assert.equal(arrivals, 2, 'both recovery calls read the same real completion receipt before publication');
    for (const result of results) {
      assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : undefined);
      if (result.status === 'fulfilled') assert.equal(result.value.kind, 'idle');
    }
  } finally {
    release(); clearTimeout(timer); controller.abort(); p.services.state.receipt = receipt;
    await Promise.allSettled(pending);
  }
  const stable = await h.records(), closed = await h.checkpoints();
  assert.ok(closed.every(value => value.value.status === 'closed' && value.value.claim === null && !value.value.pendingRun));
  const closures = stable.events.slice(original.events.length);
  assert.equal(closures.length, 2); assert.ok(closures.every(value => value.type === 'mission_checkpoint'));
  const ids = closures.map(value => z.object({ subscriptionId: z.string() }).parse(value.data.payload).subscriptionId);
  for (const item of closed) assert.equal(ids.filter(id => id === item.subscription.id).length, 1);
  assert.deepEqual(stable.events.slice(0, original.events.length), original.events); await h.preserve(original);
  assert.equal((await p.missions!.tick(h.workId, p.workflow)).kind, 'idle'); await h.preserve(stable, true);
});
