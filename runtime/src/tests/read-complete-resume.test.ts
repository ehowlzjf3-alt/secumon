import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ArtifactRef, Attempt, Evidence, TaskSpec } from '../domain/model.js';
import type { ReadItem, ReadPage } from '../domain/read-collection.js';
import type { ReadCollectionBinding, ReadCollectionSource, Tool, ToolAvailability } from '../application/ports.js';
import type { RuntimeServices } from '../application/services.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { createExecutionAuthority } from '../application/execution-authority.js';
import { createReadCollectionTool, ReadCollections } from '../application/read-collections.js';
import { ReadCheckpointRecordSchema } from '../application/read-checkpoint-record.js';
import { ToolResultSchema } from '../application/contracts.js';
import { ToolBroker } from '../application/tool-broker.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { asJson } from '../application/plan-validator.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { adapters, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const limits = { maxPages: 3, maxItems: 4, maxCalls: 4, pageSize: 2, maxPageBytes: 65536, maxCheckpointBytes: 262144 };
const measured = { transportCalls: 1, internalOperations: 2, imageBytes: 0, waitMs: 3 };
const zeroUsage = { transportCalls: 0, internalOperations: 0, imageBytes: 0, waitMs: 0 };

/** Existing checkpoint outer-result-loss fixture, with real repositories and an in-process source; no SIGKILL or MCP transport is claimed. */
async function fixture(t: TestContext, backend: Adapter, partial = false) {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-complete-resume-'));
  let repository = openRepository(backend, directory);
  t.after(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const artifacts = new FileArtifactStore(join(directory, 'artifacts'));
  const clock = new FakeClock(1000), digester = new Sha256Digester(), ids = new RandomIds();
  const work = initial('complete-resume-work'); work.budget.limits.replans = 10;
  assert.equal((await repository.commit(command(work, 'create'))).kind, 'committed');
  const rawBytes = new TextEncoder().encode('SYNTHETIC_COMPLETE_RESUME_ORIGINAL');
  const raw = await artifacts.put(rawBytes, { tenantId: work.policy.tenantId, labels: work.policy.allowedLabels, mediaType: 'text/plain' });
  const evidence: Evidence = { id: 'original-evidence', tenantId: work.policy.tenantId, scope: work.goal.scope,
    sourceId: 'original-source', lineageId: 'original-lineage', locator: 'fixture://complete-resume', observedAt: 900, recordedAt: 1000,
    labels: ['synthetic'], coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [], facts: { available: true }, artifact: raw };
  const key = (id: string) => ({ id, inputDigest: id.repeat(64) });
  const item = (id: string, success: boolean): ReadItem => ({ ...key(id), status: success ? 'success' : 'error',
    output: success ? { value: id } : null, evidence: success && id === 'a' ? [evidence] : [], artifacts: success ? [raw] : [],
    coverage: success ? 'complete' : 'unknown', error: success ? null : { code: 'fixture_partial', retryable: true } });
  const counts = { execute: 0, fetch: 0, reuse: 0 };
  const source: ReadCollectionSource = { manifest: () => [key('a'), key('b')], async fetch(_task, request, context): Promise<ReadPage> {
    counts.fetch++; await context.authorize?.();
    const items = [item('a', true), item('b', !partial)];
    return { requestId: request.requestId, sourceSnapshot: 'fixed-original', cursor: request.cursor, nextCursor: null, exhausted: true,
      totalItems: 2, expected: items.map(({ id, inputDigest }) => ({ id, inputDigest })), items, rawArtifact: raw, usage: measured };
  } };
  const definition: ReadCollectionBinding['definition'] = { provider: 'fixture', id: 'fixture.read', version: '1', description: 'Bounded original collection',
    effect: 'read', destination: 'local', labels: ['synthetic'], inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    outputSchema: { type: 'object' }, collection: { kind: 'batch', limits } };
  function open(owner: string, availability: ToolAvailability) {
    const controller = new AbortController();
    let collections!: ReadCollections;
    const wrapped = createReadCollectionTool({ definition, source, availability }, () => collections);
    const tool: Tool = { ...wrapped, async execute(task, context) { counts.execute++; return wrapped.execute(task, context); } };
    const services: RuntimeServices = { state: repository, artifacts, clock, digester, ids, tools: [tool], planner: new ScriptedPlanner([]), sink: new FakeSink(),
      executionAuthority: createExecutionAuthority({ actor: { ...work.policy }, scope: work.goal.scope, signal: controller.signal }) };
    const contracts = new ToolContracts([tool], new AjvSchemas());
    collections = new ReadCollections(services, contracts, owner);
    const runtime = new ExecutionRuntime(services, contracts, owner, 1000, undefined, collections);
    runtime.resultReuse.find = async () => { counts.reuse++; return null; };
    const broker = new ToolBroker(repository, contracts, digester, clock, async () => true, undefined, undefined, services, collections);
    return { services, contracts, collections, runtime, broker, controller };
  }
  let active = open('original-owner', 'available');
  const current = () => active.runtime.state(work.id);
  const task = (id: string, parent?: Attempt): TaskSpec => ({ id, description: 'Consume original fixture records', toolId: definition.id,
    toolVersion: definition.version, input: { query: 'original' }, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: ['criterion'],
    ...(parent ? { readResume: { attemptId: parent.id, checkpointId: parent.readProgress!.head.id } } : {}) });
  const submit = async (selected: TaskSpec) => {
    const before = await current();
    await active.runtime.submitPlan(work.id, `plan:${selected.id}`, { baseStateRevision: before.revision, baseGoalRevision: before.goal.revision,
      basePlanRevision: before.plan?.revision ?? 0, reason: 'Explicit original-checkpoint successor', tasks: [selected], hypotheses: [] });
  };
  const selected = task('parent'); await submit(selected);
  const reserved = await active.runtime.reserve(work.id, selected.id);
  assert.equal(await active.runtime.dispatch(work.id, reserved.id), true);
  const returned = await active.broker.invoke(work.id, reserved.id, active.runtime.owner, active.controller.signal);
  assert.equal(returned.status, partial ? 'partial' : 'success');
  assert.equal(counts.execute, 1); assert.equal(counts.fetch, 1);
  const interrupted = await current(), interruptedParent = interrupted.attempts.find(value => value.id === reserved.id)!;
  assert.equal(interruptedParent.status, 'running'); assert.equal(interruptedParent.resultArtifact, null);
  assert.equal(interruptedParent.readProgress!.phase, partial ? 'partial' : 'complete');
  const checkpoint = await active.collections.checkpoints.read(interrupted, reserved.id);
  const head = structuredClone(interruptedParent.readProgress!.head);
  const headBytes = await artifacts.get(head, interrupted.policy);
  const dispatchId = `dispatch:${reserved.id}`, headReceiptId = `read:${reserved.id}:${head.id}`;
  const dispatch = await repository.receipt(work.id, dispatchId), headReceipt = await repository.receipt(work.id, headReceiptId);
  assert.ok(dispatch); assert.ok(headReceipt);
  await repository.close(); repository = openRepository(backend, directory);
  active = open('reopened-owner', 'stored_only');
  assert.deepEqual(await current(), interrupted, 'reopen does not manufacture an outer result');
  clock.advance(interruptedParent.leaseUntil - clock.now() + 1);
  await active.runtime.recover(work.id, reserved.id);
  const recovered = await current(), parent = recovered.attempts.find(value => value.id === reserved.id)!;
  assert.equal(parent.status, 'failed'); assert.equal(parent.error?.code, 'lease_expired'); assert.equal(parent.owner, 'original-owner');
  assert.equal(parent.adopted, false); assert.deepEqual(parent.readProgress!.head, head);
  const baselineCounts = { ...counts };
  const assertNoCalls = () => assert.deepEqual(counts, baselineCounts, 'local resume must not enter the registered execute, source fetch, or reuse callback');
  const assertOriginals = async (linkedChild?: string) => {
    const state = await current(), old = state.attempts.find(value => value.id === parent.id)!;
    assert.deepEqual(old, { ...parent, readProgress: { ...parent.readProgress!, successorAttemptId: linkedChild ?? null } });
    assert.deepEqual(await repository.receipt(work.id, dispatchId), dispatch);
    assert.deepEqual(await repository.receipt(work.id, headReceiptId), headReceipt);
    assert.deepEqual(await artifacts.get(head, state.policy), headBytes); assert.deepEqual(Buffer.from(await artifacts.get(raw, state.policy)), Buffer.from(rawBytes));
  };
  const childEvents = async (childId: string) => (await repository.events(work.id, 0)).filter(event => {
    if (event.type !== 'read_checkpoint_committed') return false;
    assert.ok(event.data && typeof event.data === 'object' && !Array.isArray(event.data));
    const payload = event.data['payload'];
    assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
    return payload['attemptId'] === childId;
  });
  const finish = async (child: Attempt) => {
    await active.runtime.execute(work.id, child.id); await active.runtime.settlePending(child.id); await active.runtime.adopt(work.id, child.id);
    return current();
  };
  return { get active() { return active; }, get repository() { return repository; }, work, directory, artifacts, clock, digester, raw, rawBytes,
    evidence, parent, checkpoint, head, counts, baselineCounts, task, submit, current, assertNoCalls, assertOriginals, childEvents, finish };
}

for (const backend of adapters) {
  test(`${backend}: complete stored-only successor publishes once and adopts without execute, fetch or reuse`, { timeout: 20000 }, async t => {
    const f = await fixture(t, backend); const selected = f.task('local-successor', f.parent); await f.submit(selected);
    const before = await f.current();
    assert.equal(f.active.contracts.checkExecution(selected, before.policy), 'tool_connection_required');
    const child = await f.active.runtime.reserve(f.work.id, selected.id), finished = await f.finish(child);
    const adopted = finished.attempts.find(value => value.id === child.id)!;
    assert.equal(adopted.status, 'succeeded'); assert.equal(adopted.adopted, true); assert.equal(adopted.owner, 'reopened-owner');
    assert.ok(adopted.resultArtifact); assert.equal(f.active.runtime.control(finished).kind, 'complete');
    const result = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await f.artifacts.get(adopted.resultArtifact, finished.policy))));
    assert.deepEqual(result.evidence, [f.evidence]); assert.deepEqual(result.usage, zeroUsage);
    assert.equal(adopted.execution?.mode, 'invoked'); assert.equal(adopted.execution?.implementationCalls, 1);
    assert.deepEqual(adopted.execution?.usage, zeroUsage);
    assert.equal(finished.budget.used.toolCalls, before.budget.used.toolCalls + 1); assert.equal(finished.budget.reservedToolCalls, 0);
    const checkpoint = await f.active.collections.checkpoints.read(finished, child.id);
    assert.deepEqual(checkpoint.parent, { attemptId: f.parent.id, checkpoint: f.head });
    assert.deepEqual(checkpoint.collection, f.checkpoint.collection); assert.deepEqual(checkpoint.calls, f.checkpoint.calls);
    assert.equal(checkpoint.calls.some(call => call.attemptId === child.id), false);
    assert.equal((await f.childEvents(child.id)).length, 1); f.assertNoCalls(); await f.assertOriginals(child.id);
    const stable = await f.current(); await f.active.runtime.adopt(f.work.id, child.id);
    assert.deepEqual(await f.current(), stable); f.assertNoCalls();
  });
}

for (const damage of ['partial', 'query', 'head', 'raw'] as const) {
  test(`complete local resume refuses ${damage} before a new reservation or request`, { timeout: 20000 }, async t => {
    const f = await fixture(t, 'sqlite', damage === 'partial'), selected = f.task(`deny-${damage}`, f.parent);
    if (damage === 'query') selected.input = { query: 'different query' };
    await f.submit(selected);
    if (damage === 'head' || damage === 'raw') {
      const ref = damage === 'head' ? f.head : f.raw;
      const path = join(f.directory, 'artifacts', `${ref.id}.blob`), bytes = await readFile(path);
      bytes[0] = bytes[0]! ^ 1; await writeFile(path, bytes);
    }
    const before = await f.current(), events = await f.repository.events(f.work.id, 0);
    await assert.rejects(f.active.runtime.reserve(f.work.id, selected.id), /read_|checkpoint|artifact|tool_connection_required/);
    const after = await f.current(); assert.deepEqual(after, before);
    assert.deepEqual(await f.repository.events(f.work.id, 0), events); f.assertNoCalls();
    assert.equal(after.attempts.length, 1); assert.equal(after.budget.reservedToolCalls, 0);
    if (damage !== 'head' && damage !== 'raw') await f.assertOriginals();
  });
}

type Change = 'authority' | 'registration' | 'cancel';
async function change(f: Awaited<ReturnType<typeof fixture>>, kind: Change) {
  if (kind === 'authority') { f.active.controller.abort(new Error('fixture_authority_revoked')); return; }
  if (kind === 'registration') {
    const entry = f.active.contracts.get('fixture.read', '1'); assert.ok(entry);
    f.active.contracts.replaceProvider('fixture', [{ ...entry.tool }], {
      expectedEpoch: f.active.contracts.providerEpoch('fixture'), sourceRevision: 'replaced-at-local-boundary' });
    assert.notEqual(f.active.contracts.get('fixture.read', '1'), entry); return;
  }
  await f.active.runtime.command(f.work.id, 'cancel-local-consumer', { tenantId: f.work.policy.tenantId, principalId: f.work.policy.principalId },
    f.work.goal.revision, { kind: 'cancel', reason: 'Cancel at the original-checkpoint boundary' });
}

for (const phase of ['original-read', 'child-artifact'] as const) for (const mutation of ['authority', 'registration', 'cancel'] as const) {
  test(`local child ${phase}: ${mutation} prevents checkpoint publication and adoption`, { timeout: 20000 }, async t => {
    const f = await fixture(t, 'sqlite'), selected = f.task(`boundary-${phase}-${mutation}`, f.parent); await f.submit(selected);
    const child = await f.active.runtime.reserve(f.work.id, selected.id);
    const get = f.artifacts.get.bind(f.artifacts), put = f.artifacts.put.bind(f.artifacts); let hits = 0;
    const atRunningChild = async () => {
      const state = await f.current(), active = state.attempts.find(value => value.id === child.id);
      if (active?.status !== 'running' || active.readProgress) return false;
      const dispatch = await f.repository.receipt(f.work.id, `dispatch:${child.id}`);
      assert.ok(dispatch); assert.equal(dispatch.digest, f.digester.digest({ type: 'attempt_dispatched', data: { attemptId: child.id, owner: child.owner } }));
      assert.equal(dispatch.state.attempts.find(value => value.id === child.id)?.status, 'running'); return true;
    };
    if (phase === 'original-read') f.artifacts.get = async (ref, policy) => {
      const bytes = await get(ref, policy);
      if (!hits && f.digester.digest(asJson(ref)) === f.digester.digest(asJson(f.raw)) && await atRunningChild()) {
        hits++; await change(f, mutation);
      }
      return bytes;
    };
    else f.artifacts.put = async (bytes, attributes) => {
      const ref = await put(bytes, attributes);
      const parsed = ReadCheckpointRecordSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
      if (!hits && parsed.success && parsed.data.change.type === 'resume' && parsed.data.change.attemptId === child.id && await atRunningChild()) {
        assert.deepEqual(parsed.data.change.base, f.head); hits++; await change(f, mutation);
      }
      return ref;
    };
    try {
      await f.finish(child);
      assert.equal(hits, 1, 'the mutation must occur after the actual running dispatch and at the selected boundary');
      const state = await f.current(), attempt = state.attempts.find(value => value.id === child.id)!;
      assert.equal(attempt.adopted, false); assert.equal(attempt.readProgress, undefined);
      assert.deepEqual(state.evidence, []); assert.equal((await f.childEvents(child.id)).length, 0);
      assert.equal(state.attempts.find(value => value.id === f.parent.id)!.readProgress!.successorAttemptId, null);
      if (mutation === 'cancel') assert.equal(state.status, 'cancelled');
      f.assertNoCalls();
    } finally { f.artifacts.get = get; f.artifacts.put = put; }
    await f.assertOriginals();
  });
}

test('cancellation after child publication retains its lineage but cannot adopt the local projection', { timeout: 20000 }, async t => {
  const f = await fixture(t, 'file-journal'), selected = f.task('cancel-published-child', f.parent); await f.submit(selected);
  const child = await f.active.runtime.reserve(f.work.id, selected.id), get = f.artifacts.get.bind(f.artifacts); let hits = 0;
  f.artifacts.get = async (ref: ArtifactRef, policy) => {
    const bytes = await get(ref, policy);
    if (!hits && ref.id === f.raw.id) {
      const current = await f.current(), active = current.attempts.find(value => value.id === child.id);
      if (active?.status === 'running' && active.readProgress) {
        assert.equal(current.attempts.find(value => value.id === f.parent.id)!.readProgress!.successorAttemptId, child.id);
        assert.equal((await f.childEvents(child.id)).length, 1); hits++; await change(f, 'cancel');
      }
    }
    return bytes;
  };
  try {
    await f.finish(child); assert.equal(hits, 1);
    const state = await f.current(), active = state.attempts.find(value => value.id === child.id)!;
    assert.equal(state.status, 'cancelled'); assert.equal(active.adopted, false); assert.ok(active.readProgress);
    assert.deepEqual(state.evidence, []); assert.equal((await f.childEvents(child.id)).length, 1); f.assertNoCalls();
  } finally { f.artifacts.get = get; }
  await f.assertOriginals(child.id);
});
