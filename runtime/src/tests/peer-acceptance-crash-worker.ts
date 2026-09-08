import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PEER_TOOL_IDS } from '../application/peer-agents.js';
import { PeerReplySchema, PeerTicketSchema } from '../application/peer-contracts.js';
import { ToolResultSchema } from '../application/contracts.js';
import { asJson } from '../application/plan-validator.js';
import { acceptPeerEntry, peerObject, runPeerEntry, type PeerEntryOpened } from './peer-deployment-entry-fixture.js';
import { crashProfiles, publishCrashEvidence, readCrashEvidence, receiverInput, retainedRequest,
  RecoveredSchema, StoppedSchema } from './peer-acceptance-crash-fixture.js';

const [directory, mode] = process.argv.slice(2);
assert.ok(directory); assert.ok(mode === 'crash' || mode === 'recover');
const send = (kind: 'stopped' | 'recovered') => new Promise<void>((resolve, reject) => {
  assert.ok(process.send); process.send({ kind, pid: process.pid }, error => error ? reject(error) : resolve());
});
const timer = setTimeout(() => { process.stderr.write('peer_acceptance_worker_deadline\n'); process.exit(2); }, 55000);
let fixture: ReturnType<typeof crashProfiles> | undefined;
async function seed() {
  let caller: PeerEntryOpened, receiver: PeerEntryOpened;
  fixture = crashProfiles(directory!, false, async (to, request, ticket) => {
    assert.equal(to, 1);
    const original = await retainedRequest(caller.profile, request.from.workId), accepted = await receiverInput(receiver.profile, ticket);
    assert.deepEqual(original.intent.request, request);
    assert.equal(ticket.requestDigest, caller.profile.services.digester.digest(asJson(request)));
    assert.equal(original.state.attempts.length, 1);
    const attempt = original.state.attempts[0]!;
    assert.equal(attempt.toolId, PEER_TOOL_IDS[0]); assert.equal(attempt.status, 'running'); assert.equal(attempt.resultArtifact, null);
    assert.ok(attempt.leaseUntil > Date.now()); assert.ok(attempt.leaseUntil - attempt.startedAt <= 30000);
    assert.equal(await caller.profile.services.state.receipt(original.state.id, `peer-ticket:${request.id}`), null);
    assert.equal(await caller.profile.services.state.receipt(original.state.id, `peer-response:${attempt.id}`), null);
    assert.equal(original.state.budget.used.toolCalls, 1); assert.equal(original.state.budget.used.modelCalls, 1);
    assert.equal(accepted.state.modelCalls.length, 0); assert.equal(accepted.state.attempts.length, 0);
    assert.equal(accepted.state.budget.used.modelCalls, 0); assert.equal(accepted.state.budget.used.toolCalls, 0);
    assert.equal(receiver.observed.inputs.length, 0); assert.equal(receiver.observed.reads.length, 0);
    assert.ok(!(await receiver.profile.services.state.deliveries(ticket.workId)).some(value => value.kind === 'result'));
    const digest = (value: unknown) => receiver.profile.services.digester.digest(asJson(value));
    publishCrashEvidence(directory!, 'stopped', StoppedSchema.parse({ schemaVersion: 1, pid: process.pid,
      caller: original.state, receiver: accepted.state, ticket, requestArtifact: original.artifact,
      requestBytes: Buffer.from(original.bytes).toString('base64'), requestReceiptDigest: original.receipt.digest,
      receiverInputDigest: digest(accepted.input), receiverHistoryDigest: digest(accepted.history) }));
    await send('stopped');
    // The actual recipient request returned, but forwarding never returns to the caller's ticket publication.
    await new Promise<never>(() => {});
  });
  caller = await fixture.open(0); receiver = await fixture.open(1);
  const intake = await acceptPeerEntry(caller, 'accepted-before-caller-ticket');
  await runPeerEntry(caller, intake.workId); assert.fail('the parent must SIGKILL at the accepted ticket boundary');
}
async function recover() {
  const observed = StoppedSchema.parse(readCrashEvidence(directory!, 'stopped'));
  const oldLeases = ['a', 'b'].flatMap(name => {
    const root = join(directory!, name, '.secumon', 'runtime-leases');
    const found = readdirSync(root).map(file => ({ path: join(root, file), bytes: readFileSync(join(root, file), 'utf8') }))
      .filter(value => (JSON.parse(value.bytes) as { pid: number }).pid === observed.pid);
    assert.equal(found.length, 1); return found;
  });
  fixture = crashProfiles(directory!, true);
  const caller = await fixture.open(0), receiver = await fixture.open(1), p = caller.profile;
  // The marker supplies only the lookup ID and expected observations. Restoration loads the real request proof.
  const original = await retainedRequest(p, observed.caller.id), accepted = await receiverInput(receiver.profile, observed.ticket);
  assert.deepEqual(original.state, observed.caller); assert.deepEqual(accepted.state, observed.receiver);
  assert.deepEqual(original.artifact, observed.requestArtifact); assert.equal(original.receipt.digest, observed.requestReceiptDigest);
  assert.equal(Buffer.from(original.bytes).toString('base64'), observed.requestBytes);
  const digest = (value: unknown) => p.services.digester.digest(asJson(value));
  assert.equal(digest(accepted.input), observed.receiverInputDigest); assert.equal(digest(accepted.history), observed.receiverHistoryDigest);
  assert.equal(await p.services.state.receipt(original.state.id, `peer-ticket:${original.intent.request.id}`), null);
  const peer = fixture.peers(1), signal = new AbortController().signal;
  const ticket = await peer.request(original.intent.request, signal);
  assert.deepEqual(ticket, observed.ticket); assert.equal(ticket.requestDigest, digest(original.intent.request));
  assert.deepEqual(await receiverInput(receiver.profile, ticket), accepted);
  assert.equal(receiver.observed.inputs.length, 0); assert.equal(receiver.observed.reads.length, 0);

  const old = original.state.attempts[0]!;
  // Use the original production 30-second lease and clock; neither the lease nor its owner is rewritten.
  const delay = Math.max(0, old.leaseUntil - Date.now() + 20); assert.ok(delay <= 30020);
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  assert.ok(Date.now() >= old.leaseUntil);
  await p.runtime.recover(original.state.id, old.id);
  let state = await p.runtime.state(original.state.id);
  const expired = state.attempts.find(value => value.id === old.id)!;
  assert.equal(expired.status, 'failed'); assert.equal(expired.error?.code, 'lease_expired'); assert.equal(expired.effectState, 'none');
  assert.equal(expired.owner, old.owner); assert.equal(expired.leaseUntil, old.leaseUntil); assert.equal(expired.inputDigest, old.inputDigest);
  assert.deepEqual(state.goal, original.state.goal); assert.deepEqual(state.policy, original.state.policy);
  assert.deepEqual(state.conversation?.session, original.state.conversation?.session);
  assert.equal(state.deadlineAt, original.state.deadlineAt); assert.deepEqual(state.budget.limits, original.state.budget.limits);
  // This is an explicit host recovery plan, not a claim of automatic model replanning or caller goal completion.
  const taskId = 'resume-accepted-peer';
  await p.runtime.submitPlan(state.id, 'recover-accepted-peer-plan', { baseStateRevision: state.revision,
    baseGoalRevision: state.goal.revision, basePlanRevision: state.plan!.revision, hypotheses: state.hypotheses,
    reason: 'Recover the stored request and original recipient ticket after the caller process stopped.',
    tasks: [{ id: taskId, description: 'Receive the already accepted peer work using its original request.',
      toolId: PEER_TOOL_IDS[1], toolVersion: '1', effect: 'read', input: { requestId: original.intent.request.id },
      dependsOn: [], maxAttempts: 1, satisfies: [] }] });
  const attempt = await p.runtime.reserve(state.id, taskId);
  await p.runtime.execute(state.id, attempt.id); await p.runtime.adopt(state.id, attempt.id);
  state = await p.runtime.state(state.id);
  const resumed = state.attempts.find(value => value.id === attempt.id)!;
  assert.equal(resumed.status, 'succeeded', JSON.stringify({ error: resumed.error, reason: state.statusReason }));
  assert.equal(resumed.adopted, true); assert.ok(resumed.resultArtifact);
  const result = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await p.services.artifacts.get(resumed.resultArtifact, state.policy))));
  assert.equal(result.status, 'success'); assert.equal(result.coverage, 'complete'); assert.deepEqual(result.evidence, []);
  assert.equal(peerObject(result.output)?.interpretation, 'peer_assessment_not_independent_evidence');
  assert.equal(result.artifacts.length, 1);
  const response = JSON.parse(new TextDecoder().decode(await p.services.artifacts.get(result.artifacts[0]!, state.policy))) as Record<string, unknown>;
  assert.deepEqual(response.request, original.intent.request); assert.deepEqual(PeerTicketSchema.parse(response.ticket), ticket);
  const reply = PeerReplySchema.parse(response.reply); assert.equal(reply.status, 'answer'); assert.deepEqual(reply.ticket, ticket);
  assert.equal(await peer.current(original.intent.request, reply), true);
  assert.ok(await p.services.state.receipt(state.id, `peer-ticket:${original.intent.request.id}`));
  assert.ok(await p.services.state.receipt(state.id, `peer-response:${resumed.id}`));
  const retained = await retainedRequest(p, state.id);
  assert.deepEqual(retained.bytes, original.bytes); assert.deepEqual(retained.receipt, original.receipt);
  assert.deepEqual(state.attempts.find(value => value.id === old.id), expired);
  assert.deepEqual(state.goal, original.state.goal); assert.deepEqual(state.policy, original.state.policy);
  assert.deepEqual(state.conversation?.session, original.state.conversation?.session);
  assert.equal(state.deadlineAt, original.state.deadlineAt); assert.deepEqual(state.budget.limits, original.state.budget.limits);
  assert.equal(state.budget.used.toolCalls, 2); assert.equal(state.budget.used.modelCalls, 1);
  assert.equal(state.budget.reservedToolCalls, 0); assert.deepEqual(state.evidence, []); assert.equal(state.generatedAnswer, undefined);
  assert.notEqual(state.status, 'completed'); assert.equal(caller.observed.inputs.length, 0); assert.equal(caller.observed.reads.length, 0);
  const finished = await receiverInput(receiver.profile, ticket);
  assert.equal(finished.state.status, 'completed'); assert.deepEqual(finished.input, accepted.input);
  assert.equal(finished.state.deadlineAt, accepted.state.deadlineAt); assert.deepEqual(finished.state.budget.limits, accepted.state.budget.limits);
  assert.equal(finished.state.budget.used.modelCalls, 1); assert.equal(finished.state.budget.used.toolCalls, 0);
  assert.equal(receiver.observed.inputs.length, 1); assert.equal(receiver.observed.reads.length, 0);
  const binding = finished.state.conversation!.bindings.find(value => value.id === finished.state.conversation!.primaryBindingId)!;
  assert.deepEqual(await receiver.profile.services.state.workIdsForConversation(binding.tenantId, binding.principalId, binding.channel, binding.conversationId), [ticket.workId]);
  const deliveries = await receiver.profile.services.state.deliveries(ticket.workId), results = deliveries.filter(value => value.kind === 'result');
  assert.equal(results.length, 1); const delivery = results[0]!;
  assert.equal(delivery.status, 'delivered'); assert.equal(delivery.context?.binding.channel, 'peer'); assert.equal(delivery.destination, 'local');
  assert.equal(delivery.context?.binding.session?.sessionId, ticket.sessionId);
  assert.equal((await receiver.profile.services.sink.lookup!(delivery)).status, 'delivered');
  assert.equal((await receiver.profile.services.sink.send(delivery)).status, 'delivered');
  assert.deepEqual(await peer.request(original.intent.request, signal), ticket);
  await p.runtime.execute(state.id, attempt.id); await p.runtime.adopt(state.id, attempt.id);
  assert.deepEqual(await p.runtime.state(state.id), state);
  assert.deepEqual(await receiverInput(receiver.profile, ticket), finished);
  assert.deepEqual(await receiver.profile.services.state.deliveries(ticket.workId), deliveries);
  assert.equal(fixture.exchanges.length, 1); assert.deepEqual(fixture.exchanges[0]!.ticket, ticket);
  assert.equal(receiver.observed.inputs.length, 1); assert.deepEqual(caller.observed.errors, []); assert.deepEqual(receiver.observed.errors, []);
  await fixture.close(); fixture = undefined;
  for (const lease of oldLeases) assert.equal(readFileSync(lease.path, 'utf8'), lease.bytes);
  publishCrashEvidence(directory!, 'recovered', RecoveredSchema.parse({ schemaVersion: 1, pid: process.pid,
    callerId: state.id, receiverId: ticket.workId, ticket, oldAttemptId: old.id, resumeAttemptId: attempt.id,
    callerModels: 1, callerTools: 2, receiverModels: 1, receiverTools: 0, receiverResultDeliveries: 1,
    callerCompleted: false, oldLeasesPreserved: true }));
  await send('recovered');
}
let failure: unknown;
try { if (mode === 'crash') await seed(); else await recover(); }
catch (error) { failure = error; }
finally {
  if (fixture) try { await fixture.close(); } catch (error) { failure = failure ? new AggregateError([failure, error], 'peer_acceptance_worker_cleanup_failed', { cause: failure }) : error; }
  clearTimeout(timer);
}
if (failure) { console.error(failure); process.exitCode = 1; }
if (process.connected) process.disconnect();
