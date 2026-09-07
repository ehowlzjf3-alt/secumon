import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ArtifactRef, TaskSpec, WorkState } from '../domain/model.js';
import type { ReadCheckpoint } from '../domain/read-checkpoint.js';
import type { ReadPage } from '../domain/read-collection.js';
import type { ArtifactStore, ReadCollectionBinding } from '../application/ports.js';
import { ReadCheckpointReader, storeReadCheckpoint } from '../application/read-checkpoint-store.js';
import { encodeReadCheckpoint } from '../application/read-checkpoint-record.js';
import { acceptPage, initialize, nextRequest } from '../application/read-collection-validation.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { ToolResultSchema } from '../application/contracts.js';
import { asJson } from '../application/plan-validator.js';
import { transact } from '../application/work-transactions.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { Sha256Digester, RandomIds } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FakeClock, FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { adapters, command, initial, openRepository } from './state-conformance-helpers.js';

const digester = new Sha256Digester();
const bounds = { maxPages: 3, maxItems: 6, maxCalls: 4, maxPageBytes: 65536, maxCheckpointBytes: 262144, pageSize: 2 };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const unique = (refs: ArtifactRef[]) => [...new Map(refs.map(ref => [ref.id, ref])).values()];
function root(state: WorkState, attemptId = 'attempt-1'): ReadCheckpoint {
  return { schemaVersion: 1, kind: 'read_checkpoint', operationId: 'operation', workId: state.id, rootAttemptId: attemptId, attemptId,
    goal: structuredClone(state.goal), policy: structuredClone(state.policy), lifecycleGeneration: 0, toolId: 'fixture.read', toolVersion: '1',
    queryDigest: 'a'.repeat(64), contractDigest: 'b'.repeat(64), limits: { ...bounds }, collection: initialize('paged'), calls: [], parent: null,
    artifacts: [], knowledgeDependencies: [], phase: 'running', stopReason: null, createdAt: 1000, updatedAt: 1000 };
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-read-record-store-')); const artifacts = new FileArtifactStore(directory); const state = initial('store-work');
  const put = async (value: unknown, attributes = { tenantId: state.policy.tenantId, labels: state.policy.allowedLabels, mediaType: 'application/json' }) => {
    const ref = await artifacts.put(encode(value), attributes); state.artifacts.push(ref); return ref;
  };
  const store = async (checkpoint: ReadCheckpoint, base: { head: ArtifactRef; checkpoint: ReadCheckpoint } | null) => {
    const head = await storeReadCheckpoint(artifacts, digester, checkpoint, base); state.artifacts.push(head); return { checkpoint, head };
  };
  const first = await store(root(state), null); const request = nextRequest(first.checkpoint.collection, 'request-1', bounds); assert.ok(request);
  const intent: ReadCheckpoint = { ...first.checkpoint, calls: [{ request, attemptId: first.checkpoint.attemptId, status: 'intent', response: null,
    dispatchedAt: 1001, receivedAt: null, errorCode: null }], artifacts: [first.head], updatedAt: 1001 };
  const pending = await store(intent, first);
  const page: ReadPage = { requestId: request.requestId, sourceSnapshot: 'snapshot', cursor: null, nextCursor: null, exhausted: true, totalItems: 1,
    expected: [{ id: 'item', inputDigest: 'c'.repeat(64) }], items: [{ id: 'item', inputDigest: 'c'.repeat(64), status: 'success', output: { body: 'LOCAL_ORIGINAL_PAGE' },
      evidence: [], artifacts: [], coverage: 'complete', error: null }], usage: { transportCalls: 1, internalOperations: 1, imageBytes: 0, waitMs: 0 } };
  const raw = await put(page);
  const complete: ReadCheckpoint = { ...intent, calls: [{ ...intent.calls[0]!, status: 'accepted', response: raw, receivedAt: 1002 }],
    collection: acceptPage(intent.collection, request, page, bounds), artifacts: [first.head, pending.head, raw], phase: 'complete', updatedAt: 1002 };
  const latest = await store(complete, pending);
  return { directory, artifacts, state, put, store, first, pending, latest, page, raw,
    reader: () => new ReadCheckpointReader(state, artifacts, digester), remove: (ref: ArtifactRef) => rm(join(directory, `${ref.id}.blob`)) };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function fixture(run: (f: Fixture) => Promise<void>) {
  const f = await setup(); try { await run(f); } finally { await rm(f.directory, { recursive: true, force: true }); }
}

test('checkpoint store: real v2 start/intent/settle records load the logical v1 result and preserve original bytes', async () => {
  await fixture(async f => {
    const reader = f.reader(); assert.deepEqual(await reader.load(f.latest.head), f.latest.checkpoint); await reader.revalidate();
    for (const stage of [f.first, f.pending, f.latest]) {
      const stored = JSON.parse(new TextDecoder().decode(await f.artifacts.get(stage.head, f.state.policy))) as { schemaVersion: number; kind: string };
      assert.equal(stored.schemaVersion, 2); assert.equal(stored.kind, 'read_checkpoint_record');
    }
    assert.deepEqual(await reader.page(f.raw), f.page); await reader.revalidate();
    assert.equal(reader.metrics().recordApplications, 3); assert.equal(reader.metrics().pageParses, 1); assert.equal(reader.metrics().artifactReads, 4);
  });
});

test('checkpoint store: a legacy snapshot can anchor a v2 orphan resume without reissuing any raw page request', async () => {
  await fixture(async f => {
    const legacy = await f.put(f.latest.checkpoint);
    const resumed: ReadCheckpoint = { ...structuredClone(f.latest.checkpoint), attemptId: 'attempt-2', parent: { attemptId: 'attempt-1', checkpoint: legacy },
      artifacts: unique([legacy, ...f.latest.checkpoint.artifacts]), updatedAt: 1003 };
    const stored = await f.store(resumed, { head: legacy, checkpoint: f.latest.checkpoint });
    const reader = f.reader(); assert.deepEqual(await reader.load(stored.head), resumed); await reader.revalidate();
    assert.equal(reader.metrics().recordApplications, 1); assert.equal(reader.metrics().pageParses, 0);
    assert.deepEqual(resumed.calls, f.latest.checkpoint.calls); assert.deepEqual(resumed.collection, f.latest.checkpoint.collection);
  });
});

for (const selected of ['base', 'raw'] as const) for (const fault of ['missing', 'tampered'] as const) test(`checkpoint store: ${fault} ${selected} is detected through the actual file adapter`, async () => {
  await fixture(async f => {
    assert.deepEqual(await f.reader().load(f.latest.head), f.latest.checkpoint);
    const ref = selected === 'base' ? f.pending.head : f.raw;
    if (fault === 'missing') await f.remove(ref);
    else await writeFile(join(f.directory, `${ref.id}.blob`), new Uint8Array(ref.byteLength).fill(0x61));
    await assert.rejects(f.reader().load(f.latest.head));
    assert.equal(await f.artifacts.exists(f.latest.head), true, 'a valid tip must not hide a missing or corrupted dependency');
  });
});

for (const change of ['tenant', 'labels', 'missing-index'] as const) test(`checkpoint store: a base reference with ${change} cannot use an otherwise readable head`, async () => {
  await fixture(async f => {
    const value = JSON.parse(new TextDecoder().decode(await f.artifacts.get(f.latest.head, f.state.policy))) as ReturnType<typeof encodeReadCheckpoint>;
    assert.notEqual(value.change.type, 'start'); if (value.change.type === 'start') return;
    if (change === 'missing-index') f.state.artifacts = f.state.artifacts.filter(ref => ref.id !== f.pending.head.id);
    else {
      const body = await f.artifacts.get(f.pending.head, f.state.policy);
      const foreign = await f.artifacts.put(body, { tenantId: change === 'tenant' ? 'other-tenant' : f.state.policy.tenantId,
        labels: change === 'labels' ? ['restricted'] : f.state.policy.allowedLabels, mediaType: 'application/json' });
      f.state.artifacts.push(foreign); value.change.base = foreign;
    }
    const head = await f.put(value); await assert.rejects(f.reader().load(head));
  });
});

test('checkpoint store: a valid artifact hash cannot authenticate a forged logical digest', async () => {
  await fixture(async f => {
    const record = JSON.parse(new TextDecoder().decode(await f.artifacts.get(f.latest.head, f.state.policy))) as ReturnType<typeof encodeReadCheckpoint>;
    record.logicalDigest = 'f'.repeat(64); const head = await f.put(record);
    assert.equal(await f.artifacts.exists(head), true); await assert.rejects(f.reader().load(head), /read_record_invalid/);
  });
});

test('checkpoint store: returned byte/page/checkpoint mutations cannot poison a reader cache', async () => {
  await fixture(async f => {
    const reader = f.reader(); const first = await reader.original(f.raw); first.fill(0);
    assert.deepEqual(await reader.original(f.raw), encode(f.page));
    const page = await reader.page(f.raw); page.items[0]!.output = { fabricated: true }; page.expected[0]!.inputDigest = 'e'.repeat(64);
    assert.deepEqual(await reader.page(f.raw), f.page);
    const checkpoint = await reader.load(f.latest.head); checkpoint.policy.allowedLabels.push('restricted'); checkpoint.collection.pages[0]!.items[0]!.output = null;
    assert.deepEqual(await reader.load(f.latest.head), f.latest.checkpoint); await reader.revalidate();
    assert.ok(reader.metrics().artifactCacheHits > 0); assert.equal(reader.metrics().pageParses, 1);
  });
});

test('checkpoint store: shared materialization rechecks every original and a new file instance decodes cold', async () => {
  await fixture(async f => {
    const first = f.reader(); const value = await first.load(f.latest.head); await first.revalidate();
    value.collection.pages[0]!.items[0]!.output = { poisoned: true }; value.artifacts.length = 0;
    f.artifacts.resetMetrics(); const warm = f.reader();
    assert.deepEqual(await warm.load(f.latest.head), f.latest.checkpoint); await warm.revalidate();
    assert.equal(warm.metrics().logicalCacheHits, 1); assert.equal(warm.metrics().recordApplications, 0);
    assert.equal(f.artifacts.metrics().getCalls, 4, 'the tip, both base records and raw page are read again');
    assert.equal(f.artifacts.metrics().bodyReadOperations, 4); assert.equal(f.artifacts.metrics().hashCalls, 4);
    const reopened = new FileArtifactStore(f.directory); const cold = new ReadCheckpointReader(f.state, reopened, digester);
    assert.deepEqual(await cold.load(f.latest.head), f.latest.checkpoint); await cold.revalidate();
    assert.equal(cold.metrics().logicalCacheHits, 0); assert.equal(cold.metrics().recordApplications, 3);
    assert.equal(reopened.metrics().getCalls, 4);
  });
});

test('checkpoint store: shared materialization cannot hide a revoked or unindexed original', async () => {
  await fixture(async f => {
    await f.reader().load(f.latest.head);
    const missing = structuredClone(f.state); missing.artifacts = missing.artifacts.filter(ref => ref.id !== f.raw.id);
    await assert.rejects(new ReadCheckpointReader(missing, f.artifacts, digester).load(f.latest.head), /read_checkpoint_unavailable/);
    const denied = structuredClone(f.state); denied.policy.allowedLabels = [];
    await assert.rejects(new ReadCheckpointReader(denied, f.artifacts, digester).load(f.latest.head), /read_checkpoint_unavailable/);
  });
});

for (const cap of ['64-heads', '16-MiB-logical-bytes'] as const) test(`checkpoint store: shared materialization evicts at ${cap}`, async () => {
  await fixture(async f => {
    const refs: ArtifactRef[] = []; const count = cap === '64-heads' ? 65 : 3;
    for (let index = 0; index < count; index++) {
      const checkpoint = root(f.state, `bounded-attempt-${index}`);
      if (cap === '16-MiB-logical-bytes') {
        checkpoint.limits.maxCheckpointBytes = 16 * 1024 * 1024;
        checkpoint.goal.criteria = Array.from({ length: 60 }, (_, criterion) => ({ ...checkpoint.goal.criteria[0]!, id: `criterion-${criterion}`, description: 'x'.repeat(100000) }));
      }
      const ref = await f.put(checkpoint); refs.push(ref); await f.reader().load(ref);
    }
    const evicted = f.reader(); await evicted.load(refs[0]!); assert.equal(evicted.metrics().logicalCacheHits, 0);
    const retained = f.reader(); await retained.load(refs.at(-1)!); assert.equal(retained.metrics().logicalCacheHits, 1);
  });
});

test('checkpoint store: eviction during a shared materialization await preserves the logical byte budget', async () => {
  await fixture(async f => {
    const source = await f.put({ body: 'LOCAL_SOURCE_FOR_REVALIDATION' }); const refs: ArtifactRef[] = [];
    for (let index = 0; index < 3; index++) {
      const checkpoint = root(f.state, `concurrent-attempt-${index}`); checkpoint.limits.maxCheckpointBytes = 16 * 1024 * 1024;
      checkpoint.goal.criteria = Array.from({ length: 60 }, (_, criterion) => ({ ...checkpoint.goal.criteria[0]!, id: `criterion-${criterion}`, description: 'x'.repeat(100000) }));
      if (index === 0) checkpoint.artifacts.push(source);
      refs.push(await f.put(checkpoint));
    }
    let entered!: () => void; const awaitingSource = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; }); let pause = false;
    const port: ArtifactStore = { put: (bytes, attributes) => f.artifacts.put(bytes, attributes), exists: ref => f.artifacts.exists(ref), get: async (ref, policy) => {
      if (pause && ref.id === source.id) { pause = false; entered(); await barrier; }
      return f.artifacts.get(ref, policy);
    } };
    const reader = () => new ReadCheckpointReader(f.state, port, digester);
    await reader().load(refs[0]!); pause = true;
    const rechecking = reader(); const waiting = rechecking.load(refs[0]!); await awaitingSource;
    try { await reader().load(refs[1]!); await reader().load(refs[2]!); }
    finally { release(); }
    await waiting; assert.equal(rechecking.metrics().logicalCacheHits, 1);
    const second = reader(); await second.load(refs[1]!);
    assert.equal(second.metrics().logicalCacheHits, 0, 'reinstalling the first 6 MB entry must account for its bytes and evict the second');
  });
});

test('checkpoint store: an in-flight head mutation cannot seed a different artifact materialization', async () => {
  await fixture(async f => {
    let entered!: () => void; const awaitingGet = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    let wait = true;
    const port: ArtifactStore = { put: (bytes, attributes) => f.artifacts.put(bytes, attributes), exists: ref => f.artifacts.exists(ref), get: async (ref, policy) => {
      if (wait) { wait = false; entered(); await barrier; }
      return f.artifacts.get(ref, policy);
    } };
    const head = structuredClone(f.latest.head); const reader = new ReadCheckpointReader(f.state, port, digester);
    const loading = reader.load(head); await awaitingGet; Object.assign(head, f.first.head); release();
    assert.deepEqual(await loading, f.latest.checkpoint);
    const next = new ReadCheckpointReader(f.state, port, digester);
    assert.deepEqual(await next.load(f.first.head), f.first.checkpoint);
  });
});

test('checkpoint store: caller ref mutation cannot redirect cached-reference revalidation', async () => {
  await fixture(async f => {
    const reader = f.reader(); const ref = structuredClone(f.raw);
    await reader.original(ref); await reader.original(ref); await f.remove(f.raw);
    Object.assign(ref, f.first.head);
    await assert.rejects(reader.revalidate(), /read_checkpoint_unavailable/);
    await assert.rejects(f.reader().load(f.latest.head));
  });
});

test('checkpoint store: policy snapshots and exact index entries cannot be widened or aliased by callers', async () => {
  await fixture(async f => {
    const denied = await f.put({ protected: true }, { tenantId: f.state.policy.tenantId, labels: ['restricted'], mediaType: 'application/json' });
    const reader = f.reader(); f.state.policy.allowedLabels.push('restricted'); reader.state.policy.allowedLabels.push('restricted');
    f.artifacts.resetMetrics(); await assert.rejects(reader.original(denied), /read_checkpoint_unavailable/); assert.equal(f.artifacts.metrics().getCalls, 0);
    const changed = { ...f.raw, sha256: '0'.repeat(64) }; await assert.rejects(reader.original(changed), /read_checkpoint_unavailable/);
    const conflicting = structuredClone(f.state); conflicting.artifacts.push(changed);
    assert.throws(() => new ReadCheckpointReader(conflicting, f.artifacts, digester), /read_checkpoint_unavailable/);
  });
});

test('checkpoint store: cached originals require real exists checks and new readers cannot inherit a deleted source', async () => {
  await fixture(async f => {
    const reader = f.reader(); await reader.page(f.raw); await reader.page(f.raw); await f.remove(f.raw);
    f.artifacts.resetMetrics(); await assert.rejects(reader.revalidate(), /read_checkpoint_unavailable/);
    assert.equal(f.artifacts.metrics().existsCalls, 1); assert.equal(reader.metrics().revalidations, 1);
    await assert.rejects(f.reader().page(f.raw)); assert.equal(f.artifacts.metrics().getCalls, 1);
  });
});

test('checkpoint store: raw source cache stays within 16 MiB and evicted sources are fetched again', async () => {
  await fixture(async f => {
    const refs: ArtifactRef[] = [];
    for (let index = 0; index < 3; index++) {
      const ref = await f.artifacts.put(new Uint8Array(8 * 1024 * 1024).fill(index + 1), { tenantId: f.state.policy.tenantId, labels: ['synthetic'], mediaType: 'application/octet-stream' });
      refs.push(ref); f.state.artifacts.push(ref);
    }
    const reader = f.reader(); for (const ref of refs) await reader.original(ref);
    assert.equal(reader.metrics().peakCachedBytes, 16 * 1024 * 1024); assert.equal(reader.metrics().artifactReads, 3);
    await reader.original(refs[0]!); assert.equal(reader.metrics().artifactReads, 4); assert.equal(reader.metrics().artifactCacheHits, 0);
  });
});

/** Synthetic port isolates loader traversal limits; actual byte integrity is covered above with FileArtifactStore. */
function virtualChain(length: number, size: number, cycle = false) {
  const state = initial('virtual-work'); const refs = Array.from({ length }, (_, index): ArtifactRef => ({ id: `record-${index}`,
    sha256: 'a'.repeat(64), byteLength: size, mediaType: 'application/json', tenantId: state.policy.tenantId, labels: ['synthetic'] }));
  state.artifacts = refs; let gets = 0;
  const artifacts: ArtifactStore = { put: async () => { throw new Error('unused_put'); }, exists: async () => true, get: async ref => {
    gets++; const index = Number(ref.id.slice('record-'.length)); const base = refs[index + 1] ?? refs[cycle ? 0 : index]!;
    const json = encode({ schemaVersion: 2, kind: 'read_checkpoint_record', logicalDigest: 'f'.repeat(64),
      change: { type: 'stop', base, reason: 'synthetic_bound', updatedAt: 1001 } });
    assert.ok(json.byteLength <= size); const bytes = new Uint8Array(size).fill(0x20); bytes.set(json); return bytes;
  } };
  return { reader: new ReadCheckpointReader(state, artifacts, digester), refs, gets: () => gets };
}

test('checkpoint store: cycles and oversized records are rejected before decoding any logical history', async () => {
  const cycle = virtualChain(2, 1024, true); await assert.rejects(cycle.reader.load(cycle.refs[0]!), /read_checkpoint_unavailable/);
  assert.equal(cycle.gets(), 2); assert.equal(cycle.reader.metrics().recordApplications, 0);
  const oversized = virtualChain(1, 16 * 1024 * 1024 + 1); await assert.rejects(oversized.reader.load(oversized.refs[0]!), /read_checkpoint_unavailable/);
  assert.equal(oversized.gets(), 0);
});

test('checkpoint store: a record chain stops at 10000 records before requesting the next dependency', async () => {
  const chain = virtualChain(10001, 1024); await assert.rejects(chain.reader.load(chain.refs[0]!), /read_checkpoint_unavailable/);
  assert.equal(chain.gets(), 10000); assert.equal(chain.reader.metrics().recordApplications, 0);
  assert.ok(chain.reader.metrics().peakCachedBytes <= 16 * 1024 * 1024);
});

test('checkpoint store: a record chain stops at 64 MiB without caching the entire traversal', async () => {
  const chain = virtualChain(5, 16 * 1024 * 1024); await assert.rejects(chain.reader.load(chain.refs[0]!), /read_checkpoint_unavailable/);
  assert.equal(chain.gets(), 4); assert.equal(chain.reader.metrics().peakCachedBytes, 16 * 1024 * 1024);
  assert.equal(chain.reader.metrics().recordApplications, 0);
});

test('checkpoint store: a materialized base retains its chain byte cost for the next event', async () => {
  const state = initial('warm-chain-work'); const size = 16 * 1024 * 1024;
  const records: { ref: ArtifactRef; checkpoint: ReadCheckpoint; record: ReturnType<typeof encodeReadCheckpoint> }[] = [];
  const append = (checkpoint: ReadCheckpoint) => {
    const last = records.at(-1); const record = encodeReadCheckpoint(checkpoint, last ? { head: last.ref, checkpoint: last.checkpoint } : null, digester);
    const ref: ArtifactRef = { id: `bounded-record-${records.length}`, sha256: 'a'.repeat(64), byteLength: size,
      tenantId: state.policy.tenantId, labels: ['synthetic'], mediaType: 'application/json' };
    state.artifacts.push(ref); records.push({ ref, checkpoint, record }); return records.at(-1)!;
  };
  let last = append({ ...root(state), limits: { ...bounds, maxCheckpointBytes: size } });
  for (let index = 1; index <= 4; index++) {
    const stopped = index % 2 === 1;
    last = append(stopped ? { ...structuredClone(last.checkpoint), artifacts: [...last.checkpoint.artifacts, last.ref], phase: 'partial', stopReason: 'bounded_pause', updatedAt: 1000 + index }
      : { ...structuredClone(last.checkpoint), attemptId: `attempt-${index + 1}`, parent: { attemptId: last.checkpoint.attemptId, checkpoint: last.ref },
        artifacts: unique([last.ref, ...last.checkpoint.artifacts]), phase: 'running', stopReason: null, updatedAt: 1000 + index });
  }
  // Padding is legal JSON; this synthetic port isolates record traversal cost from file hashing.
  const makePort = (): ArtifactStore => ({ put: async () => { throw new Error('unused_put'); }, exists: async () => true, get: async ref => {
    const value = records.find(record => record.ref.id === ref.id)!; const bytes = new Uint8Array(size).fill(0x20); bytes.set(encode(value.record)); return bytes;
  } });
  const port = makePort(); const base = records[3]!; const coldBase = new ReadCheckpointReader(state, port, digester);
  assert.deepEqual(await coldBase.load(base.ref), base.checkpoint); assert.equal(coldBase.metrics().recordApplications, 4);
  await assert.rejects(new ReadCheckpointReader(state, port, digester).load(last.ref), /read_checkpoint_unavailable/);
  await assert.rejects(new ReadCheckpointReader(state, makePort(), digester).load(last.ref), /read_checkpoint_unavailable/);
});

for (const backend of adapters) test(`checkpoint store ${backend}: a legacy committed root resumes through v2 records into an authenticated public result`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-legacy-resume-')); const repository = openRepository(backend, directory);
  try {
    const artifacts = new FileArtifactStore(join(directory, 'artifacts')); const clock = new FakeClock(1000); const work = initial('legacy-work');
    work.policy.allowedTools.push('core.calls.get'); assert.equal((await repository.commit(command(work, 'create'))).kind, 'committed');
    let fetches = 0;
    const definition: ReadCollectionBinding['definition'] = { provider: 'fixture', id: 'fixture.read', version: '1', description: 'Read one local record',
      effect: 'read', destination: 'local', labels: ['synthetic'], inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object' }, collection: { kind: 'paged', limits: bounds } };
    const composed = await composeRuntime({ services: { state: repository, artifacts, clock, digester, ids: new RandomIds(), planner: new ScriptedPlanner([]), tools: [], sink: new FakeSink() },
      schemas: new AjvSchemas(), owner: 'store-integration', enablePlanning: false, guidanceSource: { list: async () => [], read: async () => { throw new Error('unused_guidance'); } },
      collectionTools: [{ definition, source: { fetch: async (_task, request) => {
        fetches++; return { requestId: request.requestId, sourceSnapshot: 'snapshot', cursor: request.cursor, nextCursor: null, exhausted: true, totalItems: 1,
          expected: [{ id: 'a', inputDigest: 'a'.repeat(64) }], items: [{ id: 'a', inputDigest: 'a'.repeat(64), status: 'success', output: { body: 'AUTHENTICATED_LOCAL_RESULT' },
            evidence: [], artifacts: [], coverage: 'complete', error: null }], usage: { transportCalls: 1, internalOperations: 1, imageBytes: 0, waitMs: 0 } };
      } } }] });
    const task: TaskSpec = { id: 'legacy-root-task', description: 'Start local collection', dependsOn: [], toolId: definition.id, toolVersion: definition.version,
      input: {}, effect: 'read', maxAttempts: 1, satisfies: [] };
    await composed.runtime.submitPlan(work.id, 'plan-root', { baseStateRevision: 1, baseGoalRevision: 1, basePlanRevision: 0, reason: 'Create legacy root', tasks: [task], hypotheses: [] });
    const attempt = await composed.runtime.reserve(work.id, task.id); await composed.runtime.dispatch(work.id, attempt.id);
    const current = await composed.runtime.state(work.id); const legacy = root(current, attempt.id);
    legacy.contractDigest = attempt.contractDigest!; legacy.queryDigest = digester.digest(asJson({ toolId: task.toolId, toolVersion: task.toolVersion, input: task.input }));
    const head = await artifacts.put(encode(legacy), { tenantId: current.policy.tenantId, labels: current.policy.allowedLabels, mediaType: 'application/json' });
    await transact(composed.services, work.id, 'legacy-checkpoint', 'fixture_legacy_checkpoint', { head: head.id }, state => {
      state.artifacts.push(head); const parent = state.attempts.find(value => value.id === attempt.id)!; parent.status = 'failed'; parent.finishedAt = 1000;
      parent.error = { code: 'fixture_interrupted', retryable: true }; parent.readProgress = { operationId: legacy.operationId, head, callCount: 0, remainingCalls: bounds.maxCalls,
        completedPages: 0, completedItems: 0, pendingItems: 0, unknownCalls: 0, phase: 'running', successorAttemptId: null }; state.status = 'ready';
    });
    const beforeResume = await composed.runtime.state(work.id); const childTask = { ...task, id: 'resume-legacy', readResume: { attemptId: attempt.id, checkpointId: head.id } };
    await composed.runtime.submitPlan(work.id, 'plan-resume', { baseStateRevision: beforeResume.revision, baseGoalRevision: 1, basePlanRevision: beforeResume.plan!.revision,
      reason: 'Resume the legacy checkpoint', tasks: [childTask], hypotheses: [] });
    const child = await composed.runtime.reserve(work.id, childTask.id); await composed.runtime.execute(work.id, child.id); await composed.runtime.settlePending(child.id);
    const settled = await composed.runtime.adopt(work.id, child.id); const canonical = settled.attempts.find(value => value.id === child.id)!;
    assert.equal(canonical.adopted, true); assert.equal(fetches, 1); assert.ok(canonical.resultArtifact); assert.ok(canonical.readProgress);
    const result = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await artifacts.get(canonical.resultArtifact, settled.policy))));
    assert.equal(await composed.readCheckpoints.validateResult(settled, result), true);
    assert.match(JSON.stringify(await composed.resources.result(work.id, settled.policy, child.id, 65536)), /AUTHENTICATED_LOCAL_RESULT/);
    const loaded = await new ReadCheckpointReader(settled, artifacts, digester).load(canonical.readProgress.head);
    assert.equal(loaded.rootAttemptId, attempt.id); assert.deepEqual(loaded.parent, { attemptId: attempt.id, checkpoint: head });
    assert.equal(JSON.parse(new TextDecoder().decode(await artifacts.get(canonical.readProgress.head, settled.policy))).schemaVersion, 2);
    assert.equal(JSON.parse(new TextDecoder().decode(await artifacts.get(head, settled.policy))).schemaVersion, 1);
    await rm(join(directory, 'artifacts', `${head.id}.blob`));
    assert.equal(await composed.readCheckpoints.validateResult(settled, result), false);
    await assert.rejects(composed.resources.result(work.id, settled.policy, child.id, 65536), /invocation_unavailable/); assert.equal(fetches, 1);
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});
