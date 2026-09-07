import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { composeRuntime } from '../application/compose-runtime.js';
import type { WorkState } from '../domain/model.js';
import { ScriptedPlanner } from '../infrastructure/fakes.js';
import { createMcpCollectionCustodyFixture, type CollectionCustodyCallMode } from './mcp-collection-custody-fixture.js';
import type { Adapter } from './state-conformance-helpers.js';

type Fixture = Awaited<ReturnType<typeof createMcpCollectionCustodyFixture>>;
const cases = [
  { mode: 'captured-failure', reason: 'captured', captures: 1 },
  { mode: 'sent-true', reason: 'failure', captures: 0 },
  { mode: 'returned-without-capture', reason: 'late_returned', captures: 0 },
] as const satisfies readonly { mode: CollectionCustodyCallMode; reason: string; captures: number }[];

async function interrupted(t: Parameters<typeof createMcpCollectionCustodyFixture>[0], backend: Adapter,
  scenario: typeof cases[number]) {
  const f = await createMcpCollectionCustodyFixture(t, backend), prepared = await f.prepare();
  f.controls.callMode = scenario.mode;
  const expire = async () => { f.setNow(prepared.attempt.leaseUntil + 100); };
  // Fixed decoded transport uses the production capture hook. This test does not exercise a process crash.
  // A typed transport failure has no decoded callback, so expire before its raw artifact is published.
  if (scenario.mode === 'sent-true') f.controls.beforeRaw = expire;
  else f.controls.afterCapture = expire;
  await assert.rejects(f.invoke(prepared.attempt.id), /broker_execution_not_current|read_interrupted|read_lease_unavailable/);
  assert.equal(f.requests.size, 1);
  const request = [...f.requests.values()][0]!;
  assert.ok(request.raw);
  const before = await f.current(), attempt = before.attempts[0]!;
  const checkpoint = await f.checkpoint(), response = await f.response(request), original = await f.raw(request);
  assert.ok(response); assert.equal(attempt.status, 'running');
  assert.equal(attempt.execution?.mode, 'unreported'); assert.equal(attempt.resultArtifact, null);
  assert.equal(attempt.adopted, false); assert.equal(attempt.readProgress?.unknownCalls, 1);
  assert.deepEqual(attempt.readProgress!.head, request.intentHead);
  assert.equal(checkpoint.calls.length, 1); assert.equal(checkpoint.calls[0]!.status, 'intent');
  assert.equal(checkpoint.calls[0]!.response, null); assert.equal(checkpoint.collection.pages.length, 0);
  assert.equal(f.counters.calls, 1); assert.equal(f.counters.fetches, 1);
  assert.equal(f.counters.captures, scenario.captures); assert.equal(f.counters.projections, 0);
  if (scenario.reason === 'captured') {
    assert.equal(f.sourceErrors[0], f.errors.captured);
    assert.ok(request.capture); assert.ok(request.capture.observedAt < attempt.leaseUntil);
  }
  if (scenario.reason === 'failure') assert.equal(f.sourceErrors[0], f.errors.sent);
  if (scenario.reason === 'late_returned') assert.equal(original.envelope['recordedAt'], attempt.leaseUntil + 100);
  const dispatch = await f.services.state.receipt(before.id, `dispatch:${attempt.id}`);
  const intent = await f.services.state.receipt(before.id, `read:${attempt.id}:${request.intentHead.id}`);
  assert.ok(dispatch); assert.ok(intent);
  return { f, prepared, request, before, checkpoint, response, original, dispatch, intent };
}

async function reopen(f: Fixture) {
  await f.reopen();
  return composeRuntime({ services: f.services, schemas: f.schemas, owner: 'custody-resume-reader', enablePlanning: false,
    collectionTools: [f.reader()], guidanceSource: { list: async () => [], read: async () => { throw new Error('unused'); } } });
}

for (const backend of ['sqlite', 'file-journal'] as const) for (const scenario of cases) {
  test(`${backend}: workflow settles ${scenario.reason} custody after expiring the intent within one step and without a body`, { timeout: 15000 }, async t => {
    const { f, request, before, checkpoint, response, original, dispatch, intent } = await interrupted(t, backend, scenario);
    const composed = await reopen(f), actor = { tenantId: before.policy.tenantId, principalId: before.policy.principalId };
    const counters = { ...f.counters }, steps: WorkState[] = [];
    assert.equal(composed.planning, null); assert.equal(composed.compactPlanning, null);
    assert.equal(composed.contracts.get(request.input.task.toolId, request.input.task.toolVersion)!.tool.availability, 'stored_only');
    const run = await composed.workflow.run(before.id, actor, {
      maxSteps: 1, onStep: async () => { steps.push(await f.current()); },
    });
    assert.equal(run.steps, 1); assert.equal(steps.length, 1);
    const recovered = steps[0]!.attempts[0]!;
    assert.equal(recovered.status, 'failed'); assert.equal(recovered.error?.code, 'lease_expired');
    assert.equal(recovered.execution?.mode, 'unreported', 'onStep observes expiration before the bounded usage pass');
    assert.deepEqual(recovered.readProgress, before.attempts[0]!.readProgress);
    const after = await f.current(), accounted = after.attempts[0]!;
    assert.deepEqual(accounted, { ...recovered, execution: {
      mode: 'invoked', implementationCalls: 1, usage: { transportCalls: 1, internalOperations: null, imageBytes: null, waitMs: null },
    } }, 'accounting only augments usage; it does not rewrite the expired attempt or adopt a page');
    assert.equal(accounted.owner, before.attempts[0]!.owner); assert.equal(accounted.leaseUntil, before.attempts[0]!.leaseUntil);
    assert.equal(after.attempts.length, 1); assert.equal(after.evidence.length, 0); assert.equal(after.modelCalls.length, 0);
    assert.deepEqual(after.goal, before.goal); assert.deepEqual(after.plan, before.plan); assert.deepEqual(after.budget, before.budget);
    assert.equal(after.budget.used.toolCalls, 1); assert.equal(after.budget.used.modelCalls, 0);
    assert.deepEqual(await f.checkpoint(), checkpoint); assert.deepEqual(await f.response(request), response);
    assert.deepEqual(await f.raw(request), original);
    assert.deepEqual(await f.services.state.receipt(before.id, `dispatch:${accounted.id}`), dispatch);
    assert.deepEqual(await f.services.state.receipt(before.id, `read:${accounted.id}:${request.intentHead.id}`), intent);
    assert.equal(await f.services.state.receipt(before.id, `read-reconcile:${accounted.id}:${request.intentHead.id}`), null);
    assert.deepEqual(f.counters, { ...counters, manifests: f.counters.manifests }, 'only read-only manifest validation may repeat');
    assert.ok(f.services.planner instanceof ScriptedPlanner); assert.equal(f.services.planner.inputs.length, 0);
    const events = await f.services.state.events(before.id, 0);
    assert.equal(events.filter(event => event.type === 'attempt_recovered').length, 1);
    assert.equal(events.filter(event => event.type === 'tool_execution_usage_recorded').length, 1);
    assert.equal(events.filter(event => event.type === 'read_response_reconciled').length, 0);
    const packet = JSON.parse(new TextDecoder().decode(await f.services.artifacts.get(run.checkpoint, after.policy))) as {
      context: { evidence: unknown[] }; runtime: { attempts: { resultArtifact: unknown; adopted: boolean }[] };
    };
    assert.deepEqual(packet.context.evidence, []);
    assert.equal(packet.runtime.attempts[0]!.resultArtifact, null); assert.equal(packet.runtime.attempts[0]!.adopted, false);
    const repeated = await composed.workflow.reconcileUsage(before.id, actor);
    assert.deepEqual(repeated.changed, []); assert.deepEqual(await f.current(), after);
    assert.equal((await f.services.state.events(before.id, 0)).filter(event => event.type === 'tool_execution_usage_recorded').length, 1);
    assert.equal(f.counters.calls, 1); assert.equal(f.counters.fetches, 1); assert.equal(f.counters.projections, 0);
  });
}

for (const damage of ['intent', 'raw'] as const) {
  test(`workflow rejects ${damage} corruption instead of converting it into custody-only accounting`, { timeout: 15000 }, async t => {
    const { f, request, before, checkpoint, response } = await interrupted(t, 'sqlite', cases[0]);
    const composed = await reopen(f), actor = { tenantId: before.policy.tenantId, principalId: before.policy.principalId };
    if (damage === 'intent') f.controls.damageReceipt = 'intent';
    else await writeFile(join(f.artifactDirectory, `${request.raw!.id}.blob`), '{}');
    let steps = 0;
    await assert.rejects(composed.workflow.run(before.id, actor, { maxSteps: 1, onStep: async () => { steps++; } }),
      /read_reconciliation_invalid/);
    assert.equal(steps, 0, 'body proof rejection is not reported as a completed workflow step');
    const after = await f.current(), attempt = after.attempts[0]!;
    assert.equal(attempt.status, 'failed'); assert.equal(attempt.error?.code, 'lease_expired');
    assert.equal(attempt.execution?.mode, 'unreported'); assert.equal(attempt.resultArtifact, null); assert.equal(attempt.adopted, false);
    assert.deepEqual(attempt.readProgress, before.attempts[0]!.readProgress); assert.deepEqual(await f.checkpoint(), checkpoint);
    assert.deepEqual(await f.response(request), response); assert.deepEqual(after.budget, before.budget);
    assert.equal(after.attempts.length, 1); assert.equal(after.evidence.length, 0); assert.equal(after.modelCalls.length, 0);
    const events = await f.services.state.events(before.id, 0);
    assert.equal(events.filter(event => event.type === 'attempt_recovered').length, 1);
    assert.equal(events.filter(event => event.type === 'read_response_reconciled' || event.type === 'tool_execution_usage_recorded').length, 0);
    assert.equal(f.counters.calls, 1); assert.equal(f.counters.fetches, 1); assert.equal(f.counters.projections, 0);
    assert.ok(f.services.planner instanceof ScriptedPlanner); assert.equal(f.services.planner.inputs.length, 0);
  });
}
