import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setImmediate as drain } from 'node:timers/promises';
import type { MissionEventSource } from '../application/mission-contracts.js';
import { bounded, gate, missionFixture, rule } from './mission-runtime-fixture.js';

const execute = promisify(execFile), worker = fileURLToPath(new URL('./helpers/mission-cross-process-command-worker.js', import.meta.url));
for (const stateBackend of ['sqlite', 'file-journal'] as const) test(`mission ${stateBackend}: a separate process pauses a pending source without recording a failed observation`, { timeout: 45000 }, async t => {
  const f = await missionFixture(t, ['observations'], { stateBackend }); await f.missions.register(f.workId, rule());
  const original = await f.checkpoint(), entered = gate<Parameters<MissionEventSource['poll']>[0]>(), release = gate<void>(), finished = gate<void>();
  f.poll('observations', async input => {
    entered.resolve(input);
    try { await release.promise; throw new Error('late_external_source_failure'); } finally { finished.resolve(); }
  });
  const result = f.missions.refresh(f.workId).then(value => ({ value }), error => ({ error: error as unknown }));
  try {
    const poll = await bounded(entered.promise, 5000), start = performance.now();
    const child = await execute(process.execPath, [worker, stateBackend, f.directory, f.workId], { timeout: 20000, maxBuffer: 1024 * 1024 });
    const confirmedAt = performance.now(), command = JSON.parse(child.stdout), stopped = await bounded(result, 5000), stoppedAt = performance.now();
    assert.ok('error' in stopped); assert.ok(stopped.error instanceof Error); assert.equal(stopped.error.message, 'mission_state_changed');
    assert.equal(poll.signal.aborted, true); assert.equal(stopped.error, poll.signal.reason);
    const after = await f.current(), events = await f.state.events(f.workId, 0);
    assert.equal(after.status, 'paused'); assert.equal(after.revision, command.revision); assert.equal(command.modelCalls, 0);
    assert.deepEqual(after.subscriptions, original.work.subscriptions); assert.deepEqual(after.budget, original.work.budget);
    assert.equal(events.at(-1)!.commandId, 'other-process-pause');
    assert.deepEqual(await f.state.receipt(f.workId, original.subscription.checkpointId), original.receipt);
    assert.deepEqual(await f.artifacts.get(original.artifact, original.work.policy), original.bytes);
    release.resolve(); await bounded(finished.promise); await drain(); assert.deepEqual(await f.current(), after);
    assert.equal(f.sourceCalls.length, 1); assert.equal(f.planner.inputs.length + f.tool.invocations.length, 0);
    console.log(JSON.stringify({ measurement: 'mission_cross_process_pause', stateBackend, commandProcessMs: confirmedAt - start,
      responseToObservedStopMs: stoppedAt - confirmedAt, meaning: 'Local measured elapsed time, not a real-time bound' }));
    await f.reopen(); assert.deepEqual(await f.current(), after);
  } finally { release.resolve(); await bounded(result, 5000); await bounded(finished.promise, 5000); }
});
