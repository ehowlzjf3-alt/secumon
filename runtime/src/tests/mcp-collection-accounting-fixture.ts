import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { Attempt, Evidence, ToolResult, WorkState } from '../domain/model.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { StoredReadUsages } from '../application/stored-read-usage.js';
import { createMcpCollectionCustodyFixture, type CollectionCustodyRequest } from './mcp-collection-custody-fixture.js';
import type { Adapter } from './state-conformance-helpers.js';

export type AccountingFixture = Awaited<ReturnType<typeof createMcpCollectionCustodyFixture>>;
export const selected = (state: WorkState, attemptId: string): Attempt => {
  const value = state.attempts.find(attempt => attempt.id === attemptId); assert.ok(value); return value;
};
export function onlyAccountingChanged(before: WorkState, after: WorkState, attemptId: string) {
  const normalized = structuredClone(after); normalized.revision = before.revision; normalized.updatedAt = before.updatedAt;
  const prior = selected(before, attemptId), next = selected(normalized, attemptId);
  if (prior.execution === undefined) delete next.execution; else next.execution = structuredClone(prior.execution);
  assert.deepEqual(normalized, before, 'only original attempt measurements and transaction revision/time may change');
}
export const accountingRuntime = (f: AccountingFixture, owner = 'offline-collection-accountant') =>
  new ExecutionRuntime(f.services, f.composed.contracts, owner);
export const usageEvents = async (f: AccountingFixture, workId = 'work-1') =>
  (await f.services.state.events(workId, 0)).filter(event => event.type === 'tool_execution_usage_recorded');
export const owner = (state: WorkState) => ({ tenantId: state.policy.tenantId, principalId: state.policy.principalId });
export const authorizeOwner = (original: WorkState) => (state: WorkState) => {
  assert.equal(state.id, original.id); assert.equal(state.createdAt, original.createdAt);
  assert.equal(state.policy.tenantId, original.policy.tenantId); assert.equal(state.policy.principalId, original.policy.principalId);
};
export async function originals(f: AccountingFixture) {
  return Promise.all([...f.requests.values()].map(async request => ({ requestId: request.input.request.requestId,
    receipt: await f.response(request), raw: request.raw ? { ref: structuredClone(request.raw), bytes: Buffer.from((await f.raw(request)).bytes) } : null })));
}
export async function inspected(f: AccountingFixture, attemptId: string, helper = new StoredReadUsages(f.services, f.composed.contracts)) {
  const state = await f.current(), inspection = await helper.inspectCustody(state, attemptId); assert.ok(inspection);
  return { state, helper, inspection };
}
type Invocation = { kind: 'returned'; result: ToolResult } | { kind: 'failed'; error: unknown };
interface HeldCollection {
  f: AccountingFixture;
  prepared: Awaited<ReturnType<AccountingFixture['prepare']>>;
  second: CollectionCustodyRequest;
  release(): void;
  completed: Promise<Invocation>;
}

/** One accepted page followed by an actually dispatched, captured second page whose receipt is still pending. */
export async function withHeldSecondCollection(t: TestContext, backend: Adapter,
  run: (held: HeldCollection) => Promise<void>): Promise<void> {
  const f = await createMcpCollectionCustodyFixture(t, backend, { family: 'observations' }), prepared = await f.prepare();
  let entered!: (value: CollectionCustodyRequest) => void, release!: () => void, timedOut = false;
  const ready = new Promise<CollectionCustodyRequest>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let rejectReady!: (error: Error) => void;
  const missing = new Promise<never>((_resolve, reject) => { rejectReady = reject; });
  const timer = setTimeout(() => { timedOut = true; rejectReady(new Error('second_collection_capture_timeout')); release(); }, 20000);
  f.controls.afterCapture = async request => {
    if (f.requests.size === 2) { entered(request); await gate; }
  };
  const completed: Promise<Invocation> = f.invoke(prepared.attempt.id).then(result => ({ kind: 'returned', result }), error => ({ kind: 'failed', error }));
  try {
    const second = await Promise.race([ready, missing]);
    assert.equal(f.counters.calls, 2); assert.ok(await f.response([...f.requests.values()][0]!));
    assert.equal(await f.response(second), null);
    await run({ f, prepared, second, release, completed });
    assert.equal(timedOut, false, 'the finite capture barrier was explicitly released');
  } finally { release(); clearTimeout(timer); await completed; }
}

/** Real stop plus lease recovery makes the old head non-current without inventing a result or losing originals. */
export async function protectedCollection(f: AccountingFixture) {
  const prepared = await f.prepare();
  let evidence: Evidence[] = [];
  f.controls.afterCapture = async request => {
    if (f.requests.size !== 2) return;
    evidence = (await f.checkpoint()).collection.pages.flatMap(page => page.items.flatMap(item => item.evidence));
    f.controls.callMode = 'captured-failure';
    const state = await f.current();
    await f.composed.runtime.command(prepared.workId, 'stop-after-page-capture', owner(state), state.goal.revision,
      { kind: 'cancel', reason: 'Keep the received originals, stop the work' });
    await f.mutate(next => { next.policy.allowedLabels = []; next.policy.allowedTools = []; }, request.workId);
  };
  await assert.rejects(f.invoke(prepared.attempt.id), /read_interrupted|broker_execution_not_current|read_scope_changed/);
  assert.equal(f.requests.size, 2); assert.equal(f.counters.calls, 2);
  for (const request of f.requests.values()) assert.ok(await f.response(request));
  f.setNow(prepared.attempt.leaseUntil + 1);
  await f.composed.runtime.recover(prepared.workId, prepared.attempt.id);
  const state = await f.current(), attempt = selected(state, prepared.attempt.id);
  assert.equal(state.status, 'cancelled'); assert.equal(attempt.status, 'failed'); assert.equal(attempt.error?.code, 'lease_expired');
  assert.equal(attempt.owner, prepared.attempt.owner); assert.equal(attempt.leaseUntil, prepared.attempt.leaseUntil);
  assert.equal(attempt.resultArtifact, null); assert.equal(attempt.adopted, false);
  return { prepared, state, actor: owner(state), evidence };
}
