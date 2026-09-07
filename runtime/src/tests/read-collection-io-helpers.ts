import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ArtifactStore, ReadCollectionBinding, ReadCollectionSource, StateRepository } from '../application/ports.js';
import type { ArtifactRef, Evidence, Json, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import type { ReadItem, ReadPage } from '../domain/read-collection.js';

export const ioFamilies = ['documents-simple', 'observations-simple'] as const;
export const ioAdapters = ['sqlite', 'file-journal'] as const;
export const ioPageCounts = [4, 8, 16] as const;
export type IoFamily = typeof ioFamilies[number];
export type IoAdapter = typeof ioAdapters[number];
export interface IoSnapshot {
  artifactApi: {
    get: { calls: number; requestedBodyBytes: number; returnedBodyBytes: number; failures: number };
    exists: { calls: number; referencedBodyBytes: number; available: number; unavailable: number };
    put: { calls: number; inputBodyBytes: number; returnedReferenceBodyBytes: number; failures: number };
  };
  stateApi: Record<keyof StateRepository, number>;
  physical: Record<string, number> | null;
}
export interface IoMeasurement extends IoSnapshot { name: string; elapsedMs: number }
export interface IoFixtureResult {
  adapter: IoAdapter; family: IoFamily; pages: number; itemBodyBytes: number;
  sourceSignature: string; resultSignature: string; coreStateSignature: string;
  sourceCalls: number; externalUsage: ToolResult['usage']; copyRepresentation: string;
  evidence: { id: string; lineageId: string; observedAt: number; recordedAt: number }[];
  stages: IoMeasurement[];
  notes: string[];
}
function differences<T extends object>(after: T, before: T): T {
  return Object.fromEntries(Object.entries(after).map(([key, value]) => [key, (value as number) - (before as Record<string, number>)[key]!])) as T;
}
function physicalSnapshot(stores: ArtifactStore[]): Record<string, number> | null {
  const total: Record<string, number> = {};
  for (const store of stores) {
    const source = store as ArtifactStore & { metrics?: () => unknown };
    if (typeof source.metrics !== 'function') return null;
    const snapshot = source.metrics(); assert.ok(snapshot && typeof snapshot === 'object');
    for (const [key, value] of Object.entries(snapshot)) { assert.equal(typeof value, 'number'); total[key] = (total[key] ?? 0) + (value as number); }
  }
  return total;
}

/** Public port entries are distinct from FileArtifactStore's internal probes, file operations and hash work. */
export class IoMeter {
  private counts: IoSnapshot = {
    artifactApi: { get: { calls: 0, requestedBodyBytes: 0, returnedBodyBytes: 0, failures: 0 },
      exists: { calls: 0, referencedBodyBytes: 0, available: 0, unavailable: 0 },
      put: { calls: 0, inputBodyBytes: 0, returnedReferenceBodyBytes: 0, failures: 0 } },
    stateApi: { get: 0, receipt: 0, commit: 0, events: 0, recentEventMetadata: 0, deliveries: 0, workIdsForConversation: 0, conversationWorkPage: 0, runnable: 0, close: 0 }, physical: null,
  };
  readonly physicalStores: ArtifactStore[] = [];
  snapshot(): IoSnapshot { return { ...structuredClone(this.counts), physical: physicalSnapshot(this.physicalStores) }; }
  artifacts(store: ArtifactStore): ArtifactStore {
    this.physicalStores.push(store);
    return {
      get: async (ref, policy) => {
        const count = this.counts.artifactApi.get; count.calls++; count.requestedBodyBytes += ref.byteLength;
        try { const body = await store.get(ref, policy); count.returnedBodyBytes += body.byteLength; return body; }
        catch (error) { count.failures++; throw error; }
      },
      exists: async ref => {
        const count = this.counts.artifactApi.exists; count.calls++; count.referencedBodyBytes += ref.byteLength;
        const found = await store.exists(ref); if (found) count.available++; else count.unavailable++; return found;
      },
      put: async (body, attributes) => {
        const count = this.counts.artifactApi.put; count.calls++; count.inputBodyBytes += body.byteLength;
        try { const ref = await store.put(body, attributes); count.returnedReferenceBodyBytes += ref.byteLength; return ref; }
        catch (error) { count.failures++; throw error; }
      },
    };
  }
  state(repository: StateRepository): StateRepository {
    const counts = this.counts.stateApi;
    return new Proxy(repository, { get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (typeof property === 'string' && Object.hasOwn(counts, property)) counts[property as keyof StateRepository]++;
        return Reflect.apply(value, target, args);
      };
    } });
  }
  async measure<T>(name: string, action: () => Promise<T>): Promise<{ value: T; measurement: IoMeasurement }> {
    const before = this.snapshot(); const start = performance.now(); const value = await action(); const elapsedMs = performance.now() - start; const after = this.snapshot();
    return { value, measurement: { name, elapsedMs, artifactApi: { get: differences(after.artifactApi.get, before.artifactApi.get),
      exists: differences(after.artifactApi.exists, before.artifactApi.exists), put: differences(after.artifactApi.put, before.artifactApi.put) },
      stateApi: differences(after.stateApi, before.stateApi), physical: before.physical && after.physical ? differences(after.physical, before.physical) : null } };
  }
}

/** URL injection lets the identical fixture run against preserved compiled modules without emitting current source. */
export async function loadIoRuntime(distRoot: URL) {
  const [composition, fixtures, work, schemas, digest, fakes, artifacts, repositories, contracts] = await Promise.all([
    import(new URL('application/compose-runtime.js', distRoot).href) as Promise<typeof import('../application/compose-runtime.js')>,
    import(new URL('application/fixtures.js', distRoot).href) as Promise<typeof import('../application/fixtures.js')>,
    import(new URL('application/new-work.js', distRoot).href) as Promise<typeof import('../application/new-work.js')>,
    import(new URL('infrastructure/ajv-schemas.js', distRoot).href) as Promise<typeof import('../infrastructure/ajv-schemas.js')>,
    import(new URL('infrastructure/digest.js', distRoot).href) as Promise<typeof import('../infrastructure/digest.js')>,
    import(new URL('infrastructure/fakes.js', distRoot).href) as Promise<typeof import('../infrastructure/fakes.js')>,
    import(new URL('infrastructure/file-artifacts.js', distRoot).href) as Promise<typeof import('../infrastructure/file-artifacts.js')>,
    import(new URL('tests/state-conformance-helpers.js', distRoot).href) as Promise<typeof import('./state-conformance-helpers.js')>,
    import(new URL('application/contracts.js', distRoot).href) as Promise<typeof import('../application/contracts.js')>,
  ]);
  return { composition, fixtures, work, schemas, digest, fakes, artifacts, repositories, contracts };
}
type IoRuntime = Awaited<ReturnType<typeof loadIoRuntime>>;
function object(value: Json): Record<string, Json> { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value; }
function stateMeaning(state: WorkState) {
  return { goal: state.goal, policy: state.policy, evidence: state.evidence, budget: state.budget, obligations: state.obligations,
    attempts: state.attempts.map(a => ({ taskId: a.taskId, toolId: a.toolId, status: a.status, adopted: a.adopted, effect: a.effect, effectState: a.effectState,
      execution: a.execution, startedAt: a.startedAt, finishedAt: a.finishedAt })) };
}

export async function measureCollectionIo(modules: IoRuntime, fixtureRoot: URL, input: { adapter: IoAdapter; family: IoFamily; pages: number }): Promise<IoFixtureResult> {
  const { adapter, family, pages } = input; assert.ok(ioPageCounts.includes(pages as typeof ioPageCounts[number]));
  const directory = await mkdtemp(join(tmpdir(), 'secumon-collection-io-'));
  const meter = new IoMeter(); let repository = modules.repositories.openRepository(adapter, directory); let state = meter.state(repository);
  let originalArtifacts = new modules.artifacts.FileArtifactStore(join(directory, 'artifacts')); let artifacts = meter.artifacts(originalArtifacts);
  const clock = new modules.fakes.FakeClock(1788566400000); const ids = new modules.fakes.SequenceIds(); const digester = new modules.digest.Sha256Digester();
  const scenario = modules.fixtures.validateScenario(JSON.parse(await readFile(new URL(`${family}.json`, fixtureRoot), 'utf8')));
  const workId = 'collection-io-work'; const toolId = 'fixture.collection-io'; const itemBodyBytes = 1536;
  const expected: ReadItem[] = Array.from({ length: pages }, (_, index) => {
    const id = `record-${index + 1}`; const prefix = `${family} synthetic record ${index + 1}. `; const body = prefix + 'x'.repeat(itemBodyBytes - Buffer.byteLength(prefix));
    const evidence: Evidence = { id: `${family}:${id}`, tenantId: scenario.policy.tenantId, scope: scenario.goal.scope, sourceId: `source:${id}`, lineageId: `lineage:${id}`,
      locator: `fixture://${family}/${id}`, observedAt: clock.now() - 100 + index, recordedAt: clock.now(), labels: ['synthetic'], coverage: 'complete', status: 'accepted', access: 'available',
      supersedes: [], derivedFrom: [], facts: { 'io.record': id, 'io.amount': index + 100, 'io.family': family }, artifact: null };
    return { id, inputDigest: modules.digest.sha256(`${family}:${id}`), status: 'success', output: { body }, evidence: [evidence], artifacts: [], coverage: 'complete', error: null };
  });
  const sourceRequests: ReadPage[] = [];
  const source: ReadCollectionSource = { async fetch(_task, request, context) {
    assert.equal(context.signal.aborted, false); const index = request.cursor === null ? 0 : Number(request.cursor.slice('page-'.length)) - 1;
    assert.ok(Number.isSafeInteger(index) && index >= 0 && index < pages); assert.equal(request.retryItems, null);
    const item = structuredClone(expected[index]!); const last = index === pages - 1;
    const page: ReadPage = { requestId: request.requestId, sourceSnapshot: 'synthetic-io-snapshot-v1', cursor: request.cursor,
      nextCursor: last ? null : `page-${index + 2}`, exhausted: last, totalItems: pages, expected: [{ id: item.id, inputDigest: item.inputDigest }], items: [item],
      usage: { transportCalls: 1, internalOperations: 1, imageBytes: 0, waitMs: 0 } };
    sourceRequests.push(structuredClone(page)); return page;
  } };
  const definition: ReadCollectionBinding['definition'] = { provider: 'fixture', id: toolId, version: '1', description: 'Read bounded synthetic records for internal I/O measurement',
    effect: 'read', destination: 'local', labels: ['synthetic'], inputSchema: { type: 'object', properties: { dataset: { type: 'string' } }, required: ['dataset'], additionalProperties: false },
    outputSchema: { type: 'object' }, collection: { kind: 'paged', limits: { maxPages: 16, maxItems: 16, maxCalls: 16, pageSize: 1, maxPageBytes: 65536, maxCheckpointBytes: 2 * 1024 * 1024 } } };
  const initial = modules.work.newWork({ id: workId, now: clock.now(), goal: scenario.goal, policy: { ...scenario.policy, allowedTools: [toolId, 'core.calls.get'] },
    limits: { toolCalls: 8, modelCalls: 2, tokens: 100000, replans: 8, wallTimeMs: 1000000 } });
  try {
    await state.commit({ workId, expectedRevision: 0, commandId: 'accept', commandDigest: 'synthetic-io-work', next: initial,
      events: [{ type: 'accepted', at: clock.now(), data: {} }], deliveries: [] });
    const compose = () => modules.composition.composeRuntime({ services: { state, artifacts, clock, ids, digester, tools: [], planner: new modules.fakes.ScriptedPlanner([]), sink: new modules.fakes.FakeSink() },
      schemas: new modules.schemas.AjvSchemas(), guidanceSource: { list: async () => [], read: async () => { throw new Error('unused_guidance'); } },
      owner: 'io-fixture', enablePlanning: false, collectionTools: [{ definition, source }] });
    let runtime = await compose(); const stages: IoMeasurement[] = [];
    const task = (id: string, target: string, input: Record<string, Json>): TaskSpec => ({ id, description: 'Measure a synthetic read', toolId: target, toolVersion: '1',
      input, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [] });
    const invoke = async (selected: TaskSpec) => {
      const before = await runtime.runtime.state(workId);
      await runtime.runtime.submitPlan(workId, `plan:${selected.id}:${before.revision}`, { baseStateRevision: before.revision, baseGoalRevision: before.goal.revision,
        basePlanRevision: before.plan?.revision ?? 0, reason: 'Measure canonical collection access', tasks: [selected], hypotheses: [] });
      const reserved = await runtime.runtime.reserve(workId, selected.id); await runtime.runtime.execute(workId, reserved.id);
      await runtime.runtime.settlePending(reserved.id); await runtime.runtime.adopt(workId, reserved.id);
      const after = await runtime.runtime.state(workId); const attempt = after.attempts.find(a => a.id === reserved.id)!;
      assert.equal(attempt.status, 'succeeded'); assert.equal(attempt.adopted, true); assert.ok(attempt.resultArtifact);
      return { state: after, attempt };
    };
    const readResult = async (ref: ArtifactRef, current: WorkState) => modules.contracts.ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await originalArtifacts.get(ref, current.policy))));
    const collected = await meter.measure('collect', () => invoke(task('collect', toolId, { dataset: family }))); stages.push(collected.measurement);
    const result = await readResult(collected.value.attempt.resultArtifact!, collected.value.state); const output = object(result.output);
    assert.deepEqual(output['items'], expected); assert.deepEqual(result.evidence, expected.flatMap(item => item.evidence));
    assert.deepEqual(result.usage, { transportCalls: pages, internalOperations: pages, imageBytes: 0, waitMs: 0 }); assert.equal(sourceRequests.length, pages);
    const read = await meter.measure('checkpointRead', async () => runtime.readCheckpoints.read(await runtime.runtime.state(workId), collected.value.attempt.id)); stages.push(read.measurement);
    assert.deepEqual(read.value.collection.pages.flatMap(page => page.items), expected); assert.equal(read.value.collection.exhausted, true);
    const copied = await meter.measure('callsGet', () => invoke(task('copy', 'core.calls.get', { attemptId: collected.value.attempt.id, maxBytes: 65536 }))); stages.push(copied.measurement);
    const copy = await readResult(copied.value.attempt.resultArtifact!, copied.value.state); const copyOutput = object(copy.output);
    const copyRepresentation = String(copyOutput['status']); assert.ok(['available', 'too_large'].includes(copyRepresentation));
    if (copyRepresentation === 'available') {
      const view = object(copyOutput['value']!); assert.equal(view['newObservation'], false); assert.equal(view['originalAttemptId'], collected.value.attempt.id);
      assert.deepEqual(object(view['result']!)['evidence'], result.evidence); assert.deepEqual(object(object(view['result']!)['output']!)['items'], expected);
    }
    assert.deepEqual(copied.value.state.evidence, collected.value.state.evidence); assert.equal(sourceRequests.length, pages);
    const contextLimits = { maxInputBytes: 1048576, maxInputTokens: 1050624, maxOutputTokens: 256 };
    const prepare = (callId: string) => runtime.context.prepare(copied.value.state, { callId, ...contextLimits });
    const prepared = await meter.measure('contextPrepare', () => prepare('io-before-reopen')); stages.push(prepared.measurement);
    assert.deepEqual(prepared.value.packet.goal, initial.goal); assert.equal(prepared.value.frame.metrics.extraModelCalls, 0);
    const stable = stateMeaning(copied.value.state);
    const reopened = await meter.measure('reopenAndPrepare', async () => {
      await state.close(); repository = modules.repositories.openRepository(adapter, directory); state = meter.state(repository);
      originalArtifacts = new modules.artifacts.FileArtifactStore(join(directory, 'artifacts')); artifacts = meter.artifacts(originalArtifacts); runtime = await compose();
      const restored = await runtime.runtime.state(workId); assert.deepEqual(stateMeaning(restored), stable);
      const checkpoint = await runtime.readCheckpoints.read(restored, collected.value.attempt.id);
      assert.deepEqual(checkpoint.collection.pages.flatMap(page => page.items), expected);
      return runtime.context.prepare(restored, { callId: 'io-after-reopen', ...contextLimits });
    }); stages.push(reopened.measurement);
    assert.equal(sourceRequests.length, pages); assert.deepEqual(reopened.value.packet.evidence, prepared.value.packet.evidence);
    assert.deepEqual(stateMeaning((await repository.get(workId))!), stable);
    const semanticResult = { status: result.status, effectState: result.effectState, coverage: result.coverage, items: output['items'], evidence: result.evidence, usage: result.usage };
    return { adapter, family, pages, itemBodyBytes, sourceSignature: digester.digest(expected as unknown as Json),
      resultSignature: digester.digest(semanticResult as unknown as Json), coreStateSignature: digester.digest(stable as unknown as Json),
      sourceCalls: sourceRequests.length, externalUsage: result.usage, copyRepresentation,
      evidence: result.evidence.map(({ id, lineageId, observedAt, recordedAt }) => ({ id, lineageId, observedAt, recordedAt })), stages,
      notes: ['API counts cover shared runtime service ports; fixture setup, assertions and cleanup are outside measured stages.',
        'exists referencedBodyBytes is a reference-size sum, not measured physical I/O; FileArtifactStore exists performs content verification.',
        'physical=null means the loaded runtime has no FileArtifactStore.metrics; physical counters include internal put-to-exists probes when available.',
        'Physical read operations count Node file reads and returned bytes, not kernel syscalls, disk cache misses or unsuccessful partial reads.',
        'Elapsed time is informational; local filesystem caches and concurrent work are not controlled.',
        'Context preparation uses a fixed 1MiB input-byte budget and 1MiB+2048 conservative token-estimate ceiling; no model is invoked.',
        'Equality signatures exclude storage layout, checkpoint IDs and call IDs while preserving source content, amounts, evidence identity, times, lineage and charged usage.'] };
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
}
