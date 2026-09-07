import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { createExecutionAuthority } from '../application/execution-authority.js';
import { transact } from '../application/work-transactions.js';
import { storedResultFixture } from './stored-result-fixture.js';

type Fixture = Awaited<ReturnType<typeof storedResultFixture>>;
const reopened = (f: Fixture, owner = 'reopened-executor') => new ExecutionRuntime(f.services, f.contracts, owner, 1000);
const expire = (f: Fixture) => f.clock.advance(f.attempt.leaseUntil - f.clock.now());
const events = async (f: Fixture, type: string) => (await f.state.events(f.workId, 0)).filter(value => value.type === type);

test('a foreign public receiver is rejected; verified restoration preserves the original owner, lease and exhausted budget', async () => {
  const f = await storedResultFixture(), runtime = reopened(f);
  await assert.rejects(runtime.receive(f.workId, f.attempt.id, f.result, 'invoked'), /result_owner_mismatch/);
  await assert.rejects(runtime.recover(f.workId, f.attempt.id), /attempt_not_expired/);
  assert.equal(f.controls.restoreCalls, 0);
  await transact(f.services, f.workId, 'exhaust-budget', 'fixture_limit', {}, state => { state.budget.limits.toolCalls = 1; });
  const before = await f.current(), sent = before.attempts[0]!;
  expire(f);
  const received = await runtime.recover(f.workId, sent.id), restored = received.attempts[0]!;
  assert.equal(restored.status, 'received'); assert.equal(restored.error, null);
  assert.equal(restored.owner, sent.owner); assert.equal(restored.leaseUntil, sent.leaseUntil);
  assert.equal(restored.startedAt, sent.startedAt); assert.equal(received.deadlineAt, before.deadlineAt);
  assert.deepEqual(received.budget, before.budget); assert.equal(restored.execution?.usage.transportCalls, 1);
  assert.equal(restored.execution?.implementationCalls, 1); assert.equal(f.controls.executeCalls, 0);
  const done = await runtime.adopt(f.workId, sent.id);
  assert.equal(done.attempts[0]!.adopted, true); assert.equal(done.evidence.length, 1);
  assert.equal(done.budget.used.toolCalls, 1); assert.equal(done.attempts.length, 1);
  assert.equal((await events(f, 'result_received')).length, 1); assert.equal((await events(f, 'result_settled')).length, 1);
  assert.equal(await f.state.receipt(f.workId, `recover:${sent.id}`), null);
});

test('concurrent recovery within one runtime shares receipt work without a second execution', async () => {
  const f = await storedResultFixture(), runtime = reopened(f); expire(f);
  const result = await Promise.all([runtime.recover(f.workId, f.attempt.id), runtime.recover(f.workId, f.attempt.id)]);
  assert.ok(result.every(state => state.attempts[0]!.status === 'received'));
  assert.equal((await events(f, 'result_received')).length, 1); assert.equal(f.controls.executeCalls, 0);
  await runtime.adopt(f.workId, f.attempt.id);
  const done = await f.current(); await runtime.adopt(f.workId, f.attempt.id);
  assert.deepEqual(await f.current(), done);
});

test('two independent recovery executors settle one durable result and retain source receipts', async () => {
  const f = await storedResultFixture(); expire(f);
  const source = await f.state.receipt(f.workId, f.responseCommandId);
  const a = reopened(f, 'new-owner-a'), b = reopened(f, 'new-owner-b');
  await Promise.all([a.recover(f.workId, f.attempt.id), b.recover(f.workId, f.attempt.id)]);
  assert.equal((await f.current()).attempts[0]!.status, 'received');
  assert.equal((await events(f, 'result_received')).length, 1);
  assert.equal((await events(f, 'stored_result_recovery_blocked')).length, 0);
  assert.deepEqual(await f.state.receipt(f.workId, f.responseCommandId), source);
  await b.adopt(f.workId, f.attempt.id);
  const done = await f.current(); await a.adopt(f.workId, f.attempt.id);
  assert.deepEqual(await f.current(), done); assert.equal(done.budget.used.toolCalls, 1);
  assert.equal(f.controls.executeCalls, 0);
});

for (const kind of ['absent', 'invalid'] as const) test(`${kind} stored proof blocks the original attempt without dispatching another`, async () => {
  const f = await storedResultFixture({ publishResponse: kind !== 'absent' }), runtime = reopened(f);
  if (kind === 'invalid') f.controls.valid = false;
  const before = await f.current(); expire(f);
  const stopped = await runtime.recover(f.workId, f.attempt.id);
  const code = kind === 'absent' ? 'stored_result_unavailable' : 'stored_result_recovery_failed';
  assert.equal(stopped.status, 'blocked'); assert.equal(stopped.statusReason, code);
  assert.deepEqual(stopped.attempts[0]!.error, { code, retryable: false });
  assert.equal(stopped.attempts[0]!.resultArtifact, null); assert.equal(stopped.evidence.length, 0);
  assert.deepEqual(stopped.budget, before.budget); assert.equal(stopped.attempts.length, 1);
  assert.equal(runtime.hasStoredResultCandidate(stopped), false); assert.equal(f.controls.executeCalls, 0);
  assert.equal((await events(f, 'result_received')).length, 0);
});

test('unrelated concurrent state commit discards the old ticket and the next recovery prepares current proof', async () => {
  const f = await storedResultFixture(), runtime = reopened(f); expire(f);
  f.controls.beforeRestore = async () => {
    delete f.controls.beforeRestore;
    await transact(f.services, f.workId, 'concurrent-note', 'fixture_note', {}, state => { state.statusReason = 'unrelated_note'; });
  };
  const changed = await runtime.recover(f.workId, f.attempt.id);
  assert.equal(changed.statusReason, 'unrelated_note'); assert.equal(changed.attempts[0]!.status, 'running');
  assert.equal((await events(f, 'stored_result_recovery_blocked')).length, 0);
  const received = await runtime.recover(f.workId, f.attempt.id);
  assert.equal(received.attempts[0]!.status, 'received'); assert.equal(f.controls.executeCalls, 0);
});

test('a pre-existing explicit block is preserved until an explicit resume', async () => {
  const f = await storedResultFixture(), runtime = reopened(f); expire(f);
  await transact(f.services, f.workId, 'explicit-block', 'fixture_block', {}, state => {
    state.status = 'blocked'; state.statusReason = 'user_review_required';
  });
  const before = await f.current();
  assert.deepEqual(await runtime.recover(f.workId, f.attempt.id), before);
  assert.deepEqual(await runtime.step(f.workId), { kind: 'blocked', reason: 'user_review_required' });
  assert.deepEqual(await f.current(), before); assert.equal(f.controls.restoreCalls, 0);
  await transact(f.services, f.workId, 'explicit-resume', 'fixture_resume', {}, state => {
    state.status = 'ready'; state.statusReason = 'user_resumed';
  });
  assert.equal((await runtime.recover(f.workId, f.attempt.id)).attempts[0]!.status, 'received');
});

test('a policy change during restoration prevents receipt publication and a fresh check blocks adoption', async () => {
  const f = await storedResultFixture(), runtime = reopened(f); expire(f);
  f.controls.beforeRestore = async () => {
    delete f.controls.beforeRestore;
    await transact(f.services, f.workId, 'narrow-policy', 'fixture_policy', {}, state => { state.policy.allowedLabels = []; });
  };
  await runtime.recover(f.workId, f.attempt.id);
  const stopped = await runtime.recover(f.workId, f.attempt.id);
  assert.equal(stopped.status, 'blocked'); assert.equal(stopped.statusReason, 'stored_result_recovery_failed');
  assert.equal((await events(f, 'result_received')).length, 0); assert.equal(stopped.evidence.length, 0);
  assert.equal(stopped.budget.used.toolCalls, 1); assert.equal(f.controls.executeCalls, 0);
});

test('a block committed between the outer eligibility read and the private recovery read is preserved', async () => {
  const f = await storedResultFixture(), runtime = reopened(f); expire(f);
  const read = f.state.get.bind(f.state); let intercept = true;
  f.state.get = async workId => {
    const snapshot = await read(workId);
    if (intercept) {
      intercept = false;
      await transact(f.services, workId, 'racing-block', 'fixture_block', {}, state => {
        state.status = 'blocked'; state.statusReason = 'review_before_resume';
      });
    }
    return snapshot;
  };
  const blocked = await runtime.recover(f.workId, f.attempt.id);
  assert.equal(blocked.statusReason, 'review_before_resume'); assert.equal(blocked.attempts[0]!.status, 'running');
  assert.equal((await events(f, 'stored_result_recovery_blocked')).length, 0);
  assert.equal(f.controls.restoreCalls, 0);
});

test('host authority revoked during source validation leaves the persisted invocation intact', async () => {
  const f = await storedResultFixture(), controller = new AbortController(), before = await f.current();
  const services = { ...f.services, executionAuthority: createExecutionAuthority({ actor: before.policy, scope: before.goal.scope, signal: controller.signal }) };
  const runtime = new ExecutionRuntime(services, f.contracts, 'new-owner', 1000); expire(f);
  f.controls.beforeProof = async () => { controller.abort(); };
  await assert.rejects(runtime.recover(f.workId, f.attempt.id), /execution_authority_denied/);
  assert.deepEqual(await f.current(), before); assert.equal((await events(f, 'result_received')).length, 0);
  assert.equal(f.controls.executeCalls, 0);
});

test('the final receive proof cannot revoke restoration authority and still commit a received result', async () => {
  const f = await storedResultFixture(), controller = new AbortController(), before = await f.current();
  const services = { ...f.services, executionAuthority: createExecutionAuthority({ actor: before.policy, scope: before.goal.scope, signal: controller.signal }) };
  const runtime = new ExecutionRuntime(services, f.contracts, 'new-owner', 1000); expire(f);
  f.controls.beforeProof = async () => { if (f.controls.proofCalls === 5) controller.abort(); };
  await assert.rejects(runtime.recover(f.workId, f.attempt.id), /execution_authority_denied/);
  assert.equal(f.controls.proofCalls, 5); assert.deepEqual(await f.current(), before);
  assert.equal((await events(f, 'result_received')).length, 0);
});

test('an already-received result still reaches the existing rejection settlement after authority revocation', async () => {
  const f = await storedResultFixture(), controller = new AbortController(), state = await f.current();
  await f.original.receive(f.workId, f.attempt.id, f.result, 'invoked');
  const before = await f.current();
  const services = { ...f.services, executionAuthority: createExecutionAuthority({ actor: state.policy, scope: state.goal.scope, signal: controller.signal }) };
  const runtime = new ExecutionRuntime(services, f.contracts, 'new-owner', 1000); controller.abort();
  const control = await runtime.step(f.workId);
  assert.equal(control.kind, 'continue');
  const settled = await f.current();
  assert.equal(settled.attempts[0]!.status, 'failed'); assert.equal(settled.attempts[0]!.adopted, false);
  assert.equal(settled.attempts[0]!.error?.code, 'result_permission_revoked'); assert.equal(settled.evidence.length, 0);
  assert.deepEqual(settled.attempts[0]!.execution, before.attempts[0]!.execution); assert.deepEqual(settled.budget, before.budget);
  assert.equal((await events(f, 'result_rejected')).length, 1); assert.equal(f.controls.restoreCalls, 0);
});

test('failure at the ordinary receive proof check cannot publish a normalized error as a restored result', async () => {
  const f = await storedResultFixture(), runtime = reopened(f); expire(f);
  // prepare and ticket validation pass; the independent receive proof then changes.
  f.controls.beforeProof = async () => { if (f.controls.proofCalls === 3) f.controls.valid = false; };
  const stopped = await runtime.recover(f.workId, f.attempt.id);
  assert.equal(stopped.status, 'blocked'); assert.equal(stopped.attempts[0]!.resultArtifact, null);
  assert.equal(stopped.statusReason, 'stored_result_recovery_failed');
  assert.equal((await events(f, 'result_received')).length, 0); assert.equal(stopped.evidence.length, 0);
});

test('an original owner receiving during restoration keeps its original late-result rejection', async () => {
  const f = await storedResultFixture(), runtime = reopened(f); expire(f);
  f.controls.beforeRestore = async () => {
    delete f.controls.beforeRestore;
    await f.original.receive(f.workId, f.attempt.id, f.result, 'invoked');
  };
  const received = await runtime.recover(f.workId, f.attempt.id);
  assert.equal(received.attempts[0]!.status, 'received'); assert.equal(received.attempts[0]!.error?.code, 'lease_expired');
  const settled = await runtime.adopt(f.workId, f.attempt.id);
  assert.equal(settled.attempts[0]!.adopted, false); assert.equal(settled.attempts[0]!.error?.code, 'lease_expired');
  assert.equal((await events(f, 'result_received')).length, 1); assert.equal(f.controls.executeCalls, 0);
});
