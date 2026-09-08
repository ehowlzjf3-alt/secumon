import test from 'node:test';
import assert from 'node:assert/strict';
import { PEER_TOOL_IDS } from '../application/peer-agents.js';
import { acceptedToolProgressKeys, progressGate } from '../application/work-progress.js';
import { collaborationToolKind } from '../application/collaboration-tool-identity.js';
import { snapshotTool } from '../application/tool-contracts.js';
import { asJson } from '../application/plan-validator.js';
import { PeerReviewSchema } from '../application/peer-contracts.js';
import type { Tool } from '../application/ports.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { consultInput, peerServiceFixture, reviewInput } from './peer-service-fixture.js';

const digester = new Sha256Digester();
const peerKeys = (keys: readonly string[] | undefined) => (keys ?? []).filter(value => value.startsWith('preparation:peer-answer:'));

test('native peer result proof and snapshot identity allow preparation; copied descriptors and response metadata do not create authority or new content', async t => {
  for (const input of [consultInput, reviewInput]) {
    const h = await peerServiceFixture(t), accepted = await h.execute(input), native = h.bundle.contracts.get(PEER_TOOL_IDS[0], '1')!.tool;
    assert.equal(accepted.attempt.adopted, true); assert.equal(await h.bundle.contracts.validateResult(accepted.state, accepted.result), true);
    assert.equal(collaborationToolKind(native), 'peer'); assert.equal(collaborationToolKind(snapshotTool(native)), 'peer');
    const keys = acceptedToolProgressKeys(accepted.state, accepted.task, accepted.result, digester, false, native); assert.equal(keys.length, 1);
    assert.deepEqual(peerKeys(accepted.state.progress?.knownKeys), keys); assert.deepEqual(accepted.state.evidence, []); assert.notEqual(accepted.state.status, 'completed');
    const copied: Tool = { ...native, definition: structuredClone(native.definition) };
    assert.equal(collaborationToolKind(snapshotTool(copied)), undefined);
    assert.deepEqual(acceptedToolProgressKeys(accepted.state, accepted.task, accepted.result, digester, false, snapshotTool(copied)), []);
    const changed = structuredClone(accepted.result), output = changed.output as Record<string, unknown>;
    output['requestId'] = 'another-request'; output['recipientWorkId'] = 'another-recipient-work'; output['observedAt'] = 1101;
    output['peer'] = { ...(output['peer'] as object), agentId: 'another-recipient', revision: 'another-revision' };
    output['model'] = { provider: 'other-model', model: 'other-model', revision: '2' }; output['reason'] = 'another-explanation-code';
    if (output['review']) {
      const review = PeerReviewSchema.parse(output['review']); review.targetVersion = '0'.repeat(64);
      output['review'] = review; output['text'] = JSON.stringify(review, null, 2);
    }
    // This is a pure content-classifier check, not an authenticated replacement: the actual stored proof rejects the altered envelope.
    assert.deepEqual(acceptedToolProgressKeys(accepted.state, accepted.task, changed, digester, false, native), keys);
    assert.equal(await h.bundle.contracts.validateResult(accepted.state, changed), false);
  }
});

test('new plans, new request IDs and resume of the same actual peer text do not reset the unchanged no-progress bound', async t => {
  const h = await peerServiceFixture(t), first = await h.execute(consultInput), keys = peerKeys(first.state.progress?.knownKeys);
  assert.equal(keys.length, 1); const firstRequest = h.probe.observed.requests[0]!;
  const next = await h.execute({ ...consultInput, request: 'Compare it again without a new source.' });
  assert.notEqual(h.probe.observed.requests[1]!.id, firstRequest.id); assert.notEqual(next.task.id, first.task.id);
  assert.deepEqual(peerKeys(next.state.progress?.knownKeys), keys);
  const resumed = await h.execute({ requestId: firstRequest.id }, PEER_TOOL_IDS[1]);
  assert.equal(h.probe.observed.requests.length, 2); assert.deepEqual(peerKeys(resumed.state.progress?.knownKeys), keys);
  const repeated = await h.execute({ ...consultInput, request: 'Use a third request label for the same opinion.' });
  assert.deepEqual(peerKeys(repeated.state.progress?.knownKeys), keys);
  assert.equal(repeated.state.progress?.productiveSteps, 1); assert.equal(repeated.state.progress?.consecutiveUnproductive, 3);
  assert.equal(repeated.state.progress?.policy.maxUnproductiveSteps, 3);
  assert.deepEqual(progressGate(repeated.state, h.clock.now()), { kind: 'blocked', reason: 'no_progress_limit' });
  assert.deepEqual(repeated.state.evidence, []); assert.equal(repeated.state.generatedAnswer, undefined);
});

test('an actual peer wait is not progress; its later answer is credited once while partial, reused or unadopted views are excluded', async t => {
  const h = await peerServiceFixture(t); h.probe.controls.status = 'waiting';
  const waiting = await h.execute(consultInput); assert.equal(waiting.attempt.adopted, true); assert.deepEqual(peerKeys(waiting.state.progress?.knownKeys), []);
  h.probe.controls.status = 'answer'; const answered = await h.execute({ requestId: h.probe.observed.requests[0]!.id }, PEER_TOOL_IDS[1]);
  const native = h.bundle.contracts.get(PEER_TOOL_IDS[1], '1')!.tool, keys = peerKeys(answered.state.progress?.knownKeys); assert.equal(keys.length, 1);
  assert.equal(h.probe.observed.requests.length, 1);
  for (const fault of ['partial', 'unadopted', 'reused'] as const) {
    const state = structuredClone(answered.state), result = structuredClone(answered.result), attempt = state.attempts.find(value => value.id === result.attemptId)!;
    if (fault === 'partial') { result.status = 'partial'; result.coverage = 'partial'; attempt.status = 'partial'; }
    if (fault === 'unadopted') attempt.adopted = false;
    if (fault === 'reused') result.reuse = { attemptId: waiting.attempt.id, resultId: waiting.result.resultId, resultArtifact: waiting.attempt.resultArtifact!, observedAt: 1100, cacheKey: '0'.repeat(64) };
    assert.deepEqual(acceptedToolProgressKeys(state, answered.task, result, digester, false, native), [], fault);
  }
  const repeated = await h.execute({ requestId: h.probe.observed.requests[0]!.id }, PEER_TOOL_IDS[1]);
  assert.deepEqual(peerKeys(repeated.state.progress?.knownKeys), keys); assert.equal(repeated.state.progress?.productiveSteps, 1);
});

test('changed original receipt, withdrawn peer source or revoked current permission before real adoption earns no preparation credit', async t => {
  for (const fault of ['receipt', 'source', 'policy'] as const) {
    const h = await peerServiceFixture(t), pending = await h.prepare(consultInput);
    await h.bundle.runtime.execute('caller-work', pending.attempt.id); await h.bundle.runtime.settlePending(pending.attempt.id);
    const before = (await h.state.get('caller-work'))!, attempt = before.attempts.find(value => value.id === pending.attempt.id)!;
    assert.equal(attempt.status, 'received'); assert.equal(attempt.adopted, false);
    const commandId = `peer-response:${attempt.id}`, read = h.state.receipt.bind(h.state), original = await read(before.id, commandId); assert.ok(original);
    const originalBytes = await h.artifacts.get(attempt.resultArtifact!, before.policy);
    if (fault === 'receipt') h.state.receipt = async (workId, command) => {
      const receipt = await read(workId, command); return receipt && command === commandId ? { ...receipt, digest: '0'.repeat(64) } : receipt;
    };
    if (fault === 'source') h.probe.controls.current = false;
    if (fault === 'policy') await h.edit(state => { state.policy.allowedTools = []; });
    try { await h.bundle.runtime.adopt(before.id, attempt.id); }
    finally { h.state.receipt = read; }
    const after = (await h.state.get(before.id))!;
    assert.equal(after.attempts.find(value => value.id === attempt.id)?.adopted, false); assert.deepEqual(peerKeys(after.progress?.knownKeys), []);
    assert.deepEqual(after.evidence, []); assert.equal(after.generatedAnswer, undefined);
    assert.deepEqual(await read(before.id, commandId), original);
    assert.equal(h.probe.observed.runs.length, 1);
    assert.deepEqual(await h.artifacts.get(attempt.resultArtifact!, before.policy), originalBytes);
    assert.equal(h.probe.digest(asJson(after.goal)), h.probe.digest(asJson(before.goal)));
  }
});
