import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { PEER_TOOL_IDS } from '../application/peer-agents.js';
import { ArtifactSchema, ToolResultSchema } from '../application/contracts.js';
import { asJson } from '../application/plan-validator.js';
import type { PeerRequest } from '../application/peer-contracts.js';
import { createRuntimePeerAgent } from '../presentation/host-peers.js';
import { fixture as turnFixture, replaceTurn, answer } from './agent-turn-flow-helpers.js';
import { consultInput, deferred, peerHypothesis, peerServiceFixture, reviewInput } from './peer-service-fixture.js';

const peerPayload = z.strictObject({ artifact: ArtifactSchema, value: z.unknown() });

for (const adapter of ['sqlite', 'file-journal'] as const) test(`${adapter}: peer waiting and resume retain the original request, ticket and separate response custody`, async t => {
  const h = await peerServiceFixture(t, adapter); h.probe.controls.status = 'waiting';
  const waiting = await h.execute(consultInput); assert.equal(waiting.attempt.adopted, true, JSON.stringify(waiting.result));
  const request = h.probe.observed.requests[0]!, ticket = h.probe.observed.tickets[0]!;
  assert.equal(request.from.agentId, 'caller-agent'); assert.equal(request.from.workId, 'caller-work');
  assert.equal(request.from.planRevision, 1); assert.equal(request.text, consultInput.request);
  assert.equal(ticket.requestDigest, h.probe.digest(request));
  const ids = [`peer-request:${request.id}`, `peer-ticket:${request.id}`, `peer-response:${waiting.attempt.id}`];
  const receipts = await Promise.all(ids.map(id => h.state.receipt('caller-work', id)));
  assert.ok(receipts.every(Boolean));
  const events = (await h.state.events('caller-work', 0)).filter(event => ids.includes(event.commandId));
  assert.deepEqual(events.map(event => event.type), ['peer_requested', 'peer_accepted', 'peer_response_observed']);
  const originals = await Promise.all(events.map(async event => {
    const payload = peerPayload.parse(event.data['payload']);
    const bytes = await h.artifacts.get(payload.artifact, waiting.state.policy);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)), payload.value); return bytes;
  }));
  await h.reopen(); h.probe.controls.status = 'answer';
  const resumed = await h.execute({ requestId: request.id }, PEER_TOOL_IDS[1]);
  assert.equal(resumed.attempt.adopted, true, JSON.stringify(resumed.result));
  assert.equal(h.probe.observed.requests.length, 1); assert.equal(h.probe.observed.runs.length, 2);
  assert.deepEqual(h.probe.observed.runs[1], { request, ticket });
  assert.deepEqual(await Promise.all(ids.map(id => h.state.receipt('caller-work', id))), receipts);
  for (const [index, event] of events.entries()) {
    const payload = peerPayload.parse(event.data['payload']);
    assert.deepEqual(await h.artifacts.get(payload.artifact, resumed.state.policy), originals[index]);
  }
  assert.deepEqual(resumed.state.evidence, []); assert.deepEqual(resumed.result.evidence, []); assert.equal(resumed.result.coverage, 'complete');
  assert.equal((resumed.result.output as { interpretation: string }).interpretation, 'peer_assessment_not_independent_evidence');
  assert.notEqual(resumed.state.status, 'completed');
  assert.equal(await h.bundle.contracts.validateResult(resumed.state, waiting.result), true, 'the earlier observed wait remains history');
});

test('peer review retains the exact target and structured counterargument without generating caller evidence', async t => {
  const h = await peerServiceFixture(t), reviewed = await h.execute(reviewInput);
  assert.equal(reviewed.attempt.adopted, true, JSON.stringify(reviewed.result));
  const request = h.probe.observed.requests[0]!, output = reviewed.result.output as { review: { targetVersion: string; alternative: string; basis: { kind: string } }; model: unknown };
  assert.ok(request.target); assert.equal(output.review.targetVersion, request.target.version);
  assert.match(output.review.alternative, /earlier dependency/); assert.equal(output.review.basis.kind, 'none');
  assert.deepEqual(output.model, h.probe.identity.model);
  assert.deepEqual(reviewed.state.evidence, []); assert.equal(reviewed.state.hypothesisAssessment, null);
  assert.notEqual(reviewed.state.status, 'completed');
  assert.equal(ToolResultSchema.safeParse(reviewed.result).success, true);
  assert.equal(await h.bundle.contracts.validateResult(reviewed.state, { ...reviewed.result, coverage: 'unknown' }), false);
  assert.equal(await h.bundle.contracts.validateResult(reviewed.state, reviewed.result), true);
});

test('peer stale review targets and changed registered model identity cannot reuse a retained request', async t => {
  for (const fault of ['reply-target', 'current-target', 'registered-model'] as const) {
    const h = await peerServiceFixture(t);
    if (fault === 'reply-target') {
      h.probe.controls.targetVersion = '0'.repeat(64);
      const rejected = await h.execute(reviewInput); assert.equal(rejected.attempt.adopted, false);
      assert.equal(rejected.result.status, 'error'); assert.deepEqual(rejected.state.evidence, []); continue;
    }
    h.probe.controls.status = 'waiting'; const waiting = await h.execute(reviewInput);
    assert.equal(waiting.attempt.adopted, true);
    if (fault === 'current-target') await h.edit(state => { state.hypotheses[0]!.claim = 'A changed current hypothesis.'; });
    else h.probe.identity.model.revision = '2';
    const rejected = await h.execute({ requestId: h.probe.observed.requests[0]!.id }, PEER_TOOL_IDS[1]);
    assert.equal(rejected.attempt.adopted, false); assert.equal(h.probe.observed.requests.length, 1); assert.equal(h.probe.observed.runs.length, 1);
    assert.equal(await h.bundle.contracts.validateResult(rejected.state, waiting.result), false);
    assert.deepEqual(rejected.state.evidence, []);
  }
});

test('peer ticket digest mismatch keeps only the original request and never runs the wrong recipient ticket', async t => {
  const h = await peerServiceFixture(t); h.probe.controls.ticketDigest = '0'.repeat(64);
  const rejected = await h.execute(consultInput), request = h.probe.observed.requests[0]!;
  assert.equal(rejected.attempt.adopted, false); assert.equal(h.probe.observed.runs.length, 0);
  assert.ok(await h.state.receipt('caller-work', `peer-request:${request.id}`));
  assert.equal(await h.state.receipt('caller-work', `peer-ticket:${request.id}`), null);
  assert.equal(await h.state.receipt('caller-work', `peer-response:${rejected.attempt.id}`), null);
  assert.deepEqual(rejected.state.evidence, []);
});

test('peer resume rejects a changed original receipt before any additional recipient call', async t => {
  const h = await peerServiceFixture(t); h.probe.controls.status = 'waiting';
  const waiting = await h.execute(consultInput), requestId = h.probe.observed.requests[0]!.id;
  const read = h.state.receipt.bind(h.state), original = await read('caller-work', 'peer-request:' + requestId); assert.ok(original);
  h.state.receipt = async (workId, commandId) => {
    const value = await read(workId, commandId);
    return value && commandId === 'peer-request:' + requestId ? { ...value, digest: '0'.repeat(64) } : value;
  };
  const rejected = await h.execute({ requestId }, PEER_TOOL_IDS[1]);
  assert.equal(rejected.attempt.adopted, false); assert.equal(h.probe.observed.requests.length, 1); assert.equal(h.probe.observed.runs.length, 1);
  assert.deepEqual(await read('caller-work', 'peer-request:' + requestId), original);
  assert.deepEqual(rejected.state.evidence, waiting.state.evidence);
});

test('peer cancellation or abort during a delayed reply preserves request and ticket but does not publish the late response', { timeout: 15000 }, async t => {
  for (const fault of ['cancel', 'abort'] as const) {
    const h = await peerServiceFixture(t), entered = deferred(), release = deferred(), controller = new AbortController();
    t.after(() => release.resolve());
    h.probe.controls.beforeRun = async () => { entered.resolve(); await release.promise; };
    const pending = await h.prepare(reviewInput), result = h.invoke(pending, controller.signal);
    const rejected = assert.rejects(result, /peer_unavailable/); await entered.promise;
    if (fault === 'cancel') await h.edit(state => { state.status = 'cancelled'; state.statusReason = 'user_cancelled'; });
    else controller.abort();
    release.resolve(); await rejected;
    const state = (await h.state.get('caller-work'))!, request = h.probe.observed.requests[0]!;
    assert.ok(await h.state.receipt(state.id, 'peer-request:' + request.id));
    assert.ok(await h.state.receipt(state.id, 'peer-ticket:' + request.id));
    assert.equal(await h.state.receipt(state.id, 'peer-response:' + pending.attempt.id), null);
    assert.deepEqual(state.evidence, []); assert.equal(state.generatedAnswer, undefined);
  }
});

test('peer destination and label restrictions reject consultation before disclosing the original request', async t => {
  for (const fault of ['destination', 'labels'] as const) {
    const h = await peerServiceFixture(t);
    if (fault === 'destination') Object.defineProperty(h.probe.peer, 'destination', { value: 'unregistered-destination' });
    else Object.defineProperty(h.probe.peer, 'allowedLabels', { value: [] });
    const rejected = await h.execute(consultInput);
    assert.equal(rejected.attempt.adopted, false); assert.deepEqual(h.probe.observed.requests, []); assert.deepEqual(h.probe.observed.runs, []);
    assert.equal((await h.state.events('caller-work', 0)).some(event => event.type === 'peer_requested'), false);
    assert.deepEqual(asJson(rejected.state.evidence), []);
  }
});

test('runtime peer rejects malformed review, old target version and evidence references outside its recipient work', async t => {
  for (const fault of ['malformed', 'old-target', 'foreign-evidence'] as const) {
    const f = await turnFixture(); t.after(() => f.close()); const p = f.profile;
    const request: PeerRequest = { schemaVersion: 1, id: 'native-review-' + fault, kind: 'review', text: 'Challenge the original hypothesis.',
      from: { agentId: 'different-caller', tenantId: p.actor.tenantId, principalId: 'caller-principal', workId: 'caller-work', goalRevision: 1, planRevision: 1 },
      policyDigest: p.services.digester.digest(asJson(p.policy)), generation: 0, labels: [...p.policy.allowedLabels],
      deadlineAt: p.services.clock.now() + 10000, target: { version: 'a'.repeat(64), hypothesis: structuredClone(peerHypothesis) } };
    const review = { schemaVersion: 1, targetVersion: fault === 'old-target' ? 'b'.repeat(64) : request.target!.version,
      target: peerHypothesis.claim, alternative: 'An earlier failure is possible.',
      basis: fault === 'foreign-evidence' ? { kind: 'references', references: [{ workId: 'foreign-work', evidenceId: 'foreign-original' }], caveat: 'A claimed source.' } :
        { kind: 'none', reason: 'No source was read.' }, discriminatingQuestions: ['Did this begin earlier?'], impact: 'Check the earlier records.' };
    replaceTurn(p, async input => answer(input, JSON.stringify(fault === 'malformed' ? { schemaVersion: 1 } : review)));
    const peer = createRuntimePeerAgent({ agentId: p.agentId, revision: '1', role: 'resident', scope: p.scope,
      policy: p.policy, limits: p.limits, sessions: p.sessions, workflow: p.workflow });
    const ticket = await peer.request(request, new AbortController().signal);
    await assert.rejects(peer.run(request, ticket, new AbortController().signal), fault === 'malformed' ? /./ : /peer_unavailable/);
    const recipient = await p.runtime.state(ticket.workId);
    assert.deepEqual(recipient.evidence, []); assert.ok(recipient.generatedAnswer, 'the receiver generated a reply before the peer review contract rejected it');
    assert.equal(recipient.modelCalls.filter(call => call.status === 'accepted').length, 1);
    assert.equal(recipient.policy.allowWrites, false);
  }
});

test('runtime peer checks its current model revision before executing an accepted ticket', async t => {
  const f = await turnFixture(); t.after(() => f.close()); const p = f.profile;
  const peer = createRuntimePeerAgent({ agentId: p.agentId, revision: '1', role: 'resident', scope: p.scope,
    policy: p.policy, limits: p.limits, sessions: p.sessions, workflow: p.workflow });
  const request: PeerRequest = { schemaVersion: 1, id: 'native-model-change', kind: 'consult', text: 'Give an assessment.',
    from: { agentId: 'different-caller', tenantId: p.actor.tenantId, principalId: 'caller-principal', workId: 'caller-work', goalRevision: 1, planRevision: 0 },
    policyDigest: p.services.digester.digest(asJson(p.policy)), generation: 0, labels: [...p.policy.allowedLabels], deadlineAt: p.services.clock.now() + 10000, target: null };
  const ticket = await peer.request(request, new AbortController().signal);
  const services = p.workflow.services, planner = services.planner;
  services.planner = { ...planner, identity: { ...planner.identity!, revision: 'changed-model-revision' }, propose: planner.propose.bind(planner) };
  await assert.rejects(peer.run(request, ticket, new AbortController().signal), /peer_unavailable/);
  assert.equal((await p.runtime.state(ticket.workId)).modelCalls.length, 0);
});
