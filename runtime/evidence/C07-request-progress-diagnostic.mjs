import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { boardDeploymentFixture, acceptEntry, runEntry, specs } from '../dist/tests/board-deployment-entry-fixture.js';

// Run explicitly against the already compiled build5; this file does not build sources.
test('C07 request progress diagnostic from fixed build5', { timeout: 60000 }, async t => {
  const f = boardDeploymentFixture(t), a = await f.open(0), b = await f.open(1);
  await f.setup(a.profile);
  const request = await acceptEntry(b, 'request', 'explicit-request', undefined, specs[0].roleId);
  assert.equal((await runEntry(b, request.workId)).result.control.kind, 'wait');
  await b.close();
  const reopened = await f.open(1);
  const duplicate = await acceptEntry(reopened, 'request', 'explicit-request', request.sessionId, specs[0].roleId);
  assert.equal(duplicate.accepted, false); assert.equal(duplicate.workId, request.workId);
  for (let i = 0; i < 2; i++) assert.equal((await runEntry(reopened, request.workId)).result.control.kind, 'wait');
  const intake = await acceptEntry(a, 'accept', 'accept-observed-request');
  let failure;
  try { await runEntry(a, intake.workId); } catch (error) { failure = error; }
  try {
    const state = await a.profile.runtime.state(intake.workId);
    const packets = a.observed.inputs.filter(input => input.packet.workId === intake.workId).map(input => input.packet);
    const report = {
      schemaVersion: 1, fixtureBuild: 'existing build5 dist', stage: 'responder after request acceptance',
      failed: failure !== undefined, status: state.status, reason: state.statusReason,
      progress: state.progress, budget: state.budget.used,
      models: state.modelCalls.map(call => ({ id: call.id, purpose: call.purpose, status: call.status,
        reason: call.reason, outcome: call.outcome, replyPresent: call.replyArtifact !== null })),
      attempts: state.attempts.map(attempt => ({ taskId: attempt.taskId, toolId: attempt.toolId,
        status: attempt.status, adopted: attempt.adopted, error: attempt.error })),
      packets: packets.map(packet => ({ stateRevision: packet.stateRevision, planRevision: packet.planRevision,
        activeToolIds: packet.activeToolIds, evidenceIds: (packet.evidence ?? []).map(value => value.id),
        observations: (packet.toolObservations ?? []).map(value => ({ taskId: value.taskId, toolId: value.toolId,
          status: value.status, representation: value.representation,
          outputStatus: value.output?.status, boardRevision: value.output?.revision,
          requests: Array.isArray(value.output?.requests) ? value.output.requests.map(request => ({
            id: request.id, status: request.status, effectiveStatus: request.effectiveStatus,
            acceptedWorkId: request.acceptedWorkId })) : undefined })) }))
    };
    const bytes = JSON.stringify(report, null, 2) + '\n';
    assert.ok(Buffer.byteLength(bytes) <= 65536, 'diagnostic exceeds 64 KiB');
    writeFileSync(new URL('./C07-request-progress-diagnostic.json', import.meta.url), bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (failure) throw new AggregateError([failure, error], 'original request failure and diagnostic failure', { cause: failure });
    throw error;
  }
  if (failure) throw failure;
});
