import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ArtifactRef, Attempt, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import type { ReadItem, ReadKey, ReadLimits, ReadPage, ReadRequest } from '../domain/read-collection.js';
import type { ArtifactStore, ReadCollectionSource, ReadPageProofInput, Tool, ToolDefinition } from '../application/ports.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { ToolResultSchema } from '../application/contracts.js';
import { ReadPageSchema } from '../application/read-collection-contracts.js';
import { ReadCheckpointReader } from '../application/read-checkpoint-store.js';
import { createReadCollectionTool } from '../application/read-collections.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { ToolBroker } from '../application/tool-broker.js';
import { asJson } from '../application/plan-validator.js';
import { transact } from '../application/work-transactions.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { adapters, artifact, attempt, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const limits: ReadLimits = { maxPages: 4, maxItems: 10, maxCalls: 6, maxPageBytes: 65536, maxCheckpointBytes: 262144, pageSize: 2 };
const digester = new Sha256Digester();
const same = (a: unknown, b: unknown) => digester.digest(asJson(a)) === digester.digest(asJson(b));
const key = (id: string): ReadKey => ({ id, inputDigest: digester.digest({ id }) });
const item = (id: string, success = true): ReadItem => ({ ...key(id), status: success ? 'success' : 'partial',
  output: success ? { record: id } : null, evidence: [], artifacts: [], coverage: success ? 'complete' : 'partial', error: null });
const task = (id = 'task', parent?: Attempt): TaskSpec => ({ id, description: 'Read synthetic proof records', dependsOn: [],
  toolId: 'fixture.read', toolVersion: '1', effect: 'read', input: {}, maxAttempts: 1, satisfies: [],
  ...(parent ? { readResume: { attemptId: parent.id, checkpointId: parent.readProgress!.head.id } } : {}) });
const definition = (marked = true, kind: 'batch' | 'paged' = 'batch'): ToolDefinition => ({ provider: 'fixture', id: 'fixture.read', version: '1',
  description: 'Read synthetic individual page originals', effect: 'read', destination: 'local', labels: ['synthetic'],
  inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'object' },
  collection: { kind, limits, ...(marked ? { pageValidation: 'artifact-proof-v1' } : {}) } });
function page(request: ReadRequest, items: ReadItem[]): ReadPage {
  return { requestId: request.requestId, sourceSnapshot: 'synthetic-data-snapshot', cursor: request.cursor, nextCursor: null,
    exhausted: true, totalItems: items.length, expected: items.map(({ id, inputDigest }) => ({ id, inputDigest })), items,
    usage: { transportCalls: 1, internalOperations: null, imageBytes: 0, waitMs: 0 } };
}
function proofPair() {
  const state = initial(); state.attempts = [attempt('running')]; const selected = task();
  const request: ReadRequest = { requestId: 'request', cursor: null, snapshot: null, retryItems: null, itemLimit: 2 };
  return { state, input: { attemptId: 'attempt', task: selected, request, page: { ...page(request, []), rawArtifact: artifact() } } satisfies ReadPageProofInput };
}
function proofTool(validateReadPage?: Tool['validateReadPage'], marked = true): Tool {
  return { definition: definition(marked), execute: async () => { throw new Error('proof_must_not_execute'); },
    ...(validateReadPage ? { validateReadPage } : {}) };
}

test('read page proof: marker makes callback removal an atomic rejected provider refresh', () => {
  const contracts = new ToolContracts([proofTool(async () => true)], new AjvSchemas()); const before = contracts.get('fixture.read', '1');
  assert.throws(() => new ToolContracts([proofTool()], new AjvSchemas()), /tool_page_validator_required/);
  assert.throws(() => contracts.replaceProvider('fixture', [proofTool()], { expectedEpoch: 1, sourceRevision: 'removed-validator' }), /tool_page_validator_required/);
  assert.strictEqual(contracts.get('fixture.read', '1'), before); assert.equal(contracts.providerEpoch('fixture'), 1);
  assert.notEqual(digester.digest(asJson(definition())), digester.digest(asJson(definition(false))));
  assert.throws(() => createReadCollectionTool({ definition: definition(), source: { manifest: () => [], fetch: async () => { throw new Error('unused'); } } },
    () => { throw new Error('unused'); }), /tool_page_validator_required/);
});

test('read page proof: source callback is captured and receives detached original task, request and page', async () => {
  const { state, input } = proofPair(); const before = structuredClone({ state, input }); let checks = 0;
  const source: ReadCollectionSource = { manifest: () => [], fetch: async () => { throw new Error('unused'); },
    validatePage: async (copy, value) => { checks++; copy.goal.description = 'mutated'; value.task.id = 'changed'; value.request.cursor = 'changed';
      value.page.items.push(item('fabricated')); return false; } };
  const tool = createReadCollectionTool({ definition: definition(), source }, () => { throw new Error('unused'); });
  const contracts = new ToolContracts([tool], new AjvSchemas()); source.validatePage = async () => true;
  assert.equal(await contracts.validateReadPage(state, input), false); assert.equal(checks, 1); assert.deepEqual({ state, input }, before);
  assert.equal(Object.isFrozen(contracts.get('fixture.read', '1')!.tool), true);
});

test('read page proof: same-version replacement during async validation invalidates its result', async () => {
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  const contracts = new ToolContracts([proofTool(async () => { entered(); await waiting; return true; })], new AjvSchemas());
  const { state, input } = proofPair(); const pending = contracts.validateReadPage(state, input); await ready;
  contracts.replaceProvider('fixture', [proofTool(async () => true)], { expectedEpoch: 1, sourceRevision: 'new-handler' });
  release(); assert.equal(await pending, false); assert.equal(await contracts.validateReadPage(state, input), true);
});

test('read page proof: legacy serialization is unchanged and a marked source cannot omit its original', async () => {
  const { state, input } = proofPair(); const { rawArtifact: _raw, ...plain } = input.page;
  assert.deepEqual(ReadPageSchema.parse(plain), plain);
  const contracts = new ToolContracts([proofTool(async () => true)], new AjvSchemas());
  assert.equal(await contracts.validateReadPage(state, { ...input, page: plain }), false);
  assert.equal(await contracts.validateReadPage(state, { ...input, attemptId: 'missing' }), false);
  assert.equal(await new ToolContracts([proofTool(undefined, false)], new AjvSchemas()).validateReadPage(state, { ...input, page: plain }), true);
});

/** This fixture validates core custody only; it performs no MCP, model, browser or other external calls. */
async function harness(t: TestContext, backend: Adapter, empty = false) {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-read-page-proof-')); let repository = openRepository(backend, directory);
  t.after(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const clock = new FakeClock(1000); const underlying = new FileArtifactStore(join(directory, 'artifacts')); const blocked = new Set<string>();
  const artifacts: ArtifactStore = { put: (bytes, attributes) => underlying.put(bytes, attributes),
    get: async (ref, policy) => { if (blocked.has(ref.id)) throw new Error('synthetic_original_missing'); return underlying.get(ref, policy); },
    exists: ref => blocked.has(ref.id) ? Promise.resolve(false) : underlying.exists(ref) };
  const requests: { attemptId: string; request: ReadRequest }[] = []; const originals: ArtifactRef[] = [];
  const checks: { attemptId: string; taskId: string; ids: string[] }[] = [];
  let beforeAuthorize: ((context: Parameters<ReadCollectionSource['fetch']>[2]) => Promise<void>) | null = null;
  let duringProof: ((state: WorkState, input: ReadPageProofInput) => Promise<void>) | null = null;
  const source: ReadCollectionSource = {
    manifest: () => empty ? [] : [key('a'), key('b')],
    async fetch(selected, request, context) {
      await beforeAuthorize?.(context); assert.ok(context.authorize); await context.authorize();
      requests.push({ attemptId: context.attemptId, request: structuredClone(request) });
      const received = page(request, empty ? [] : request.retryItems ? [item('b')] : [item('a'), item('b', false)]);
      received.totalItems = empty ? 0 : 2;
      const ref = await artifacts.put(new TextEncoder().encode(JSON.stringify({ workId: context.workId, attemptId: context.attemptId,
        taskId: selected.id, request, received })), { tenantId: context.policy.tenantId, labels: context.policy.allowedLabels, mediaType: 'application/json' });
      originals.push(ref); return { ...received, rawArtifact: ref };
    },
    async validatePage(state, input) {
      checks.push({ attemptId: input.attemptId, taskId: input.task.id, ids: input.page.items.map(value => value.id) });
      if (!input.page.rawArtifact) return false;
      const stored = JSON.parse(new TextDecoder().decode(await artifacts.get(input.page.rawArtifact, state.policy))) as {
        workId: string; attemptId: string; taskId: string; request: ReadRequest; received: ReadPage };
      await duringProof?.(state, input);
      const { rawArtifact: _raw, ...received } = input.page;
      return stored.workId === state.id && stored.attemptId === input.attemptId && stored.taskId === input.task.id &&
        same(stored.request, input.request) && same(stored.received, received);
    },
  };
  const compose = () => composeRuntime({ services: { state: repository, artifacts, clock, tools: [], planner: new ScriptedPlanner([]),
    sink: new FakeSink(), ids: new RandomIds(), digester }, schemas: new AjvSchemas(), owner: 'page-proof-fixture', enablePlanning: false,
    guidanceSource: { list: async () => [], read: async () => { throw new Error('unused'); } }, collectionTools: [{ definition: definition(), source }] });
  assert.equal((await repository.commit(command(initial(), 'create'))).kind, 'committed'); let composed = await compose();
  const current = () => composed.runtime.state('work-1');
  const prepare = async (selected: TaskSpec, dispatch = false) => {
    const state = await current();
    await composed.runtime.submitPlan(state.id, `plan:${selected.id}`, { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision,
      basePlanRevision: state.plan?.revision ?? 0, reason: 'Exercise synthetic original custody', tasks: [selected], hypotheses: [] });
    const reserved = await composed.runtime.reserve(state.id, selected.id);
    if (dispatch) await composed.runtime.dispatch(state.id, reserved.id);
    return reserved;
  };
  const run = async (selected: TaskSpec, adopt = true) => {
    const reserved = await prepare(selected); const state = await current();
    await composed.runtime.execute(state.id, reserved.id); await composed.runtime.settlePending(reserved.id);
    if (adopt) await composed.runtime.adopt(state.id, reserved.id);
    const next = await current(); const found = next.attempts.find(value => value.id === reserved.id)!; assert.ok(found.resultArtifact);
    const result: ToolResult = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await artifacts.get(found.resultArtifact, next.policy))));
    return { state: next, attempt: found, result };
  };
  return { get composed() { return composed; }, get repository() { return repository; }, current, prepare, run, originals, requests, checks, artifacts, underlying, source, blocked,
    beforeAuthorize: (value: typeof beforeAuthorize) => { beforeAuthorize = value; }, duringProof: (value: typeof duringProof) => { duringProof = value; },
    edit: (id: string, change: (state: WorkState) => void) => transact(composed.services, 'work-1', id, 'synthetic_proof_change', { id }, change),
    reopen: async () => { await repository.close(); repository = openRepository(backend, directory); composed = await compose(); } };
}

const contextOptions = { callId: 'proof-context', maxOutputTokens: 100, maxInputBytes: 100000, maxInputTokens: 1000000, forceCompact: true };
for (const backend of adapters) {
  test(`read page proof ${backend}: explicit resume verifies individual responses and keeps the earlier successful original`, async t => {
    const h = await harness(t, backend); const parent = await h.run(task('parent'));
    assert.equal(parent.attempt.adopted, true); assert.equal(parent.result.status, 'partial');
    await h.reopen(); const child = await h.run(task('child', parent.attempt));
    assert.equal(child.attempt.adopted, true); assert.equal(child.result.status, 'success');
    assert.deepEqual(h.requests.map(value => value.request.retryItems?.map(key => key.id) ?? null), [null, ['b']]);
    assert.equal(child.result.usage!.transportCalls, 1); assert.equal(h.originals.length, 2);
    const cp = await h.composed.readCheckpoints.read(await h.current(), child.attempt.id);
    assert.deepEqual(cp.collection.pages[0]!.items.map(value => value.id), ['a', 'b']);
    assert.equal(cp.collection.pages[0]!.rawArtifact!.id, h.originals[1]!.id);
    assert.ok(h.originals.every(ref => cp.artifacts.some(value => same(value, ref))));
    assert.ok(h.checks.some(value => value.attemptId === parent.attempt.id && value.taskId === 'parent' && value.ids.join() === 'a,b'));
    assert.ok(h.checks.some(value => value.attemptId === child.attempt.id && value.taskId === 'child' && value.ids.join() === 'b'));
    const current = await h.current(); const frame = await h.composed.context.prepare(current, contextOptions);
    assert.equal(await h.composed.context.sourcesCurrent(frame.packet, current), true);
    h.blocked.add(h.originals[0]!.id);
    assert.equal(await h.artifacts.exists(child.attempt.readProgress!.head), true);
    assert.equal(await h.composed.readCheckpoints.validateResult(current, child.result), false);
    assert.equal(await h.composed.context.sourcesCurrent(frame.packet, current), false);
    await assert.rejects(h.composed.recovery.restore(current.id, current.policy), /resume_.*unavailable/);
    assert.equal(h.requests.length, 2); assert.deepEqual(await h.current(), current);
  });

  test(`read page proof ${backend}: a zero-item page retains its raw ref and raw loss blocks pending adoption`, async t => {
    const h = await harness(t, backend, true); const completed = await h.run(task('empty'), false);
    assert.equal(completed.result.status, 'success'); assert.equal(completed.result.evidence.length, 0);
    const cp = await h.composed.readCheckpoints.read(await h.current(), completed.attempt.id);
    assert.ok(cp.artifacts.some(ref => ref.id === h.originals[0]!.id)); assert.equal(cp.collection.pages[0]!.items.length, 0);
    h.blocked.add(h.originals[0]!.id);
    await assert.rejects(h.composed.runtime.adopt('work-1', completed.attempt.id), /artifact_unavailable/);
    const after = await h.current(); assert.equal(after.attempts.find(value => value.id === completed.attempt.id)!.adopted, false);
    assert.equal(h.requests.length, 1);
  });

  test(`read page proof ${backend}: missing parent original prevents any resumed source request`, async t => {
    const h = await harness(t, backend); const parent = await h.run(task('parent'));
    const reserved = await h.prepare(task('blocked-child', parent.attempt), true);
    h.blocked.add(h.originals[0]!.id);
    const broker = new ToolBroker(h.repository, h.composed.contracts, digester, h.composed.services.clock);
    await assert.rejects(broker.invoke('work-1', reserved.id, 'page-proof-fixture', new AbortController().signal), /read_checkpoint_unavailable|synthetic_original_missing/);
    assert.equal(h.requests.length, 1);
    assert.equal((await h.current()).attempts.find(value => value.id === parent.attempt.id)!.readProgress!.successorAttemptId, null);
  });

  test(`read page proof ${backend}: authority after a source wait prevents input when work is paused`, async t => {
    const h = await harness(t, backend);
    h.beforeAuthorize(async () => { await h.edit('pause-before-input', state => { state.status = 'paused'; state.statusReason = 'host_pause'; }); });
    const result = await h.run(task('paused-request'));
    assert.equal(result.attempt.adopted, false); assert.equal(h.requests.length, 0); assert.equal(h.originals.length, 0);
    assert.equal((await h.current()).status, 'paused');
  });

  test(`read page proof ${backend}: replacing the provider during the post-Broker checkpoint read blocks the old source`, async t => {
    const h = await harness(t, backend); let targetHead: string | null = null; let replaced = false;
    h.beforeAuthorize(async context => {
      const current = await h.current(); targetHead = current.attempts.find(value => value.id === context.attemptId)!.readProgress!.head.id;
    });
    const get = h.artifacts.get.bind(h.artifacts);
    h.artifacts.get = async (ref, policy) => {
      const bytes = await get(ref, policy);
      if (!replaced && targetHead === ref.id) {
        replaced = true;
        const installed = h.composed.contracts.get('fixture.read', '1')!.tool;
        h.composed.contracts.replaceProvider('fixture', [installed], {
          expectedEpoch: h.composed.contracts.providerEpoch('fixture'), sourceRevision: 'same-definition-new-entry',
        });
      }
      return bytes;
    };
    const result = await h.run(task('replaced-request'));
    assert.equal(replaced, true); assert.equal(result.attempt.adopted, false); assert.equal(result.result.status, 'error');
    assert.equal(h.requests.length, 0); assert.equal(h.originals.length, 0);
    assert.equal(h.composed.contracts.providerEpoch('fixture'), 2);
  });

  test(`read page proof ${backend}: first-read originals stay in the final fence and loss after a callback is rejected`, async t => {
    const h = await harness(t, backend); const parent = await h.run(task('parent')); const state = await h.current();
    const raw = h.originals[0]!; const reader = new ReadCheckpointReader(state, h.artifacts, digester);
    await reader.proofOriginal(raw, limits.maxPageBytes); h.blocked.add(raw.id);
    await assert.rejects(reader.revalidate(), /read_checkpoint_unavailable/); h.blocked.clear();
    let removed = false;
    h.duringProof(async (_state, input) => { if (!removed && input.page.rawArtifact?.id === raw.id) { removed = true; h.blocked.add(raw.id); } });
    await assert.rejects(h.composed.readCheckpoints.read(state, parent.attempt.id), /read_checkpoint_unavailable/);
    assert.equal(removed, true); assert.deepEqual(await h.current(), state); assert.equal(h.requests.length, 1);
  });
}
