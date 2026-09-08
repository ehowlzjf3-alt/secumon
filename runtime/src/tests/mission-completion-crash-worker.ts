import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { closeSync, fsyncSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { asJson } from '../application/plan-validator.js';
import { RESIDENT_RULE, residentEntryFixture, residentEvent } from './resident-missions-entry-fixture.js';

const [directory] = process.argv.slice(2); assert.ok(directory); assert.equal(realpathSync(directory), directory);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const watchdog = setTimeout(() => { process.stderr.write('mission_completion_worker_deadline\n'); process.exit(2); }, 60000);
let fixture: Awaited<ReturnType<typeof residentEntryFixture>> | undefined, failure: unknown;
try {
  // The parent owns cleanup. The observation file is a test record, never a recovery input or a new completion receipt.
  fixture = await residentEntryFixture({ after() {} } as unknown as TestContext, false, { base: directory });
  const f = fixture, p = f.current(); f.controls.readMission = true;
  const event = residentEvent('completion-crash-event', 'MISSION_COMPLETION_CRASH_ORIGINAL'); f.pages.first.push([event]);
  const session = await p.sessions.open(p.actor, { channel: 'test', conversationId: 'resident-conversation' });
  const accepted = await p.turns.accept(p.actor, { sessionId: session.scope.sessionId, messageId: 'completion-crash-request',
    rawText: 'Read the incoming event and report what it says.', mode: 'auto', scope: p.scope, policy: p.policy, limits: p.limits, binding: f.binding('first') });
  assert.ok(p.missions); await p.missions.register(accepted.workId, RESIDENT_RULE);
  const run = p.workflow.run.bind(p.workflow), receipt = p.services.state.receipt.bind(p.services.state);
  const digest = (value: unknown) => p.services.digester.digest(asJson(value));
  let completionCommand: string | undefined, runCalls = 0;
  p.services.state.receipt = async (workId, commandId) => {
    const value = await receipt(workId, commandId);
    if (workId === accepted.workId && commandId.startsWith('control:') && value?.state.status === 'completed') completionCommand = commandId;
    return value;
  };
  p.workflow.run = async (...args) => {
    runCalls++; const result = await run(...args);
    assert.equal(result.control.kind, 'complete'); assert.equal(result.reason, 'criteria_verified'); assert.equal(runCalls, 1);
    const state = await p.runtime.state(accepted.workId); assert.equal(state.status, 'completed'); assert.equal(result.stateRevision, state.revision);
    assert.ok(completionCommand); const completion = await receipt(state.id, completionCommand); assert.ok(completion);
    assert.equal(completion.digest, digest({ type: 'control_selected', data: { kind: 'complete', reason: 'criteria_verified' } }));
    const subscription = state.subscriptions?.find(value => value.provider === 'mission'); assert.ok(subscription);
    assert.equal(subscription.status, 'closed');
    const artifact = state.artifacts.find(value => subscription.checkpointId === `mission:${value.sha256}`); assert.ok(artifact);
    const checkpointReceipt = await receipt(state.id, subscription.checkpointId); assert.ok(checkpointReceipt);
    const checkpointBytes = await p.services.artifacts.get(artifact, state.policy); assert.equal(sha(checkpointBytes), artifact.sha256);
    const checkpoint = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(checkpointBytes)) as Record<string, unknown>;
    assert.equal(checkpoint['status'], 'active'); assert.equal(checkpoint['pendingRun'], true); assert.ok(checkpoint['claim']);
    assert.ok(checkpoint['acknowledgedRead']); assert.deepEqual(checkpoint['events'], [event]);
    const originalSubscription = checkpointReceipt.state.subscriptions?.find(value => value.id === subscription.id); assert.ok(originalSubscription);
    assert.deepEqual({ ...originalSubscription, status: 'closed' }, subscription);
    assert.equal(checkpointReceipt.digest, digest({ type: 'mission_checkpoint', data: { subscriptionId: subscription.id, artifact } }));
    assert.equal(state.budget.used.modelCalls, 3); assert.equal(state.budget.used.toolCalls, 2);
    assert.equal(f.observed.inputs.first.length, 3); assert.equal(f.observed.inputs.second.length, 0); assert.equal(f.observed.polls.length, 1);
    const basis = state.conversation?.session; assert.ok(basis);
    const input = await p.sessions.repository.input(basis.scope, basis.input.messageId); assert.ok(input);
    const acceptReceipt = await receipt(state.id, 'conversation.accept'); assert.ok(acceptReceipt);
    const history = await p.sessions.history(p.actor, session.scope.sessionId, p.policy, { limit: 100 });
    const deliveries = await p.services.state.deliveries(state.id);
    assert.equal(deliveries.filter(value => value.kind === 'result' && value.status === 'delivered').length, 1);
    const originals: { ref: typeof artifact; base64: string }[] = []; let originalBytes = 0;
    for (const ref of state.artifacts) {
      const bytes = await p.services.artifacts.get(ref, state.policy); originalBytes += bytes.byteLength;
      assert.ok(bytes.byteLength <= 512 * 1024 && originalBytes <= 2 * 1024 * 1024);
      assert.equal(bytes.byteLength, ref.byteLength); assert.equal(sha(bytes), ref.sha256);
      originals.push({ ref, base64: Buffer.from(bytes).toString('base64') });
    }
    const record = { schemaVersion: 1, event, state, workflow: result, completion: { commandId: completionCommand, receipt: completion },
      checkpoint: { artifact, receipt: checkpointReceipt, base64: Buffer.from(checkpointBytes).toString('base64') },
      input, acceptReceipt, history, deliveries, originals };
    const bytes = Buffer.from(JSON.stringify(record)); assert.ok(bytes.byteLength <= 4 * 1024 * 1024);
    const file = openSync(join(directory, 'mission-completion-observed.json'), 'wx', 0o600);
    try { writeFileSync(file, bytes); fsyncSync(file); } finally { closeSync(file); }
    const parent = openSync(directory, 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
    const message = { kind: 'workflow-complete', pid: process.pid, base: directory, workId: state.id, agentId: p.agentId,
      sessionId: session.scope.sessionId, recordSha256: sha(bytes), stateDigest: digest(state), completionDigest: digest(completion),
      checkpointSha256: artifact.sha256, observedAt: Date.now() };
    assert.ok(Buffer.byteLength(JSON.stringify(message)) <= 16384); assert.ok(process.send);
    await new Promise<void>((resolve, reject) => process.send!(message, error => error ? reject(error) : resolve()));
    // The real workflow has returned complete. MissionRuntime cannot publish its post-workflow closed checkpoint until this wrapper returns.
    await new Promise<never>(() => {});
    return result;
  };
  await p.missions.tick(accepted.workId, p.workflow, { maxSteps: 20 });
  assert.fail('parent must SIGKILL before the mission completion checkpoint publication');
} catch (error) { failure = error; }
finally {
  if (fixture) for (const role of ['first', 'second'] as const) {
    try { await fixture.current(role).close(); }
    catch (error) { failure = failure ? new AggregateError([failure, error], 'mission_completion_worker_cleanup_failed', { cause: failure }) : error; }
  }
  clearTimeout(watchdog);
}
if (failure) { console.error(failure); process.exitCode = 1; }
if (process.connected) process.disconnect();
