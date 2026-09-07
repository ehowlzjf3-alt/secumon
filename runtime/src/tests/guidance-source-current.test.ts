import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ArtifactRef, ContextPacket, TaskSpec } from '../domain/model.js';
import type { ModelCallOptions, StateRepository } from '../application/ports.js';
import { GuidanceCatalog, type GuidanceManifest, type GuidanceSource } from '../application/guidance.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { PlanningRuntime } from '../application/planning-runtime.js';
import { RESOURCE_TOOL_IDS } from '../application/resource-tools.js';
import { transact } from '../application/work-transactions.js';
import { FileGuidanceSource } from '../infrastructure/file-guidance.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { RandomIds, Sha256Digester, sha256 } from '../infrastructure/digest.js';
import { FakeClock, FakeSink } from '../infrastructure/fakes.js';
import { StructuredPlannerAdapter, type StructuredPlannerRequest } from '../infrastructure/structured-planner.js';
import { adapters, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const workId = 'source-current'; const body = 'GUIDANCE_BODY_FROM_ORIGINAL_SOURCE';
const manifest: GuidanceManifest = { id: 'core.current-guide', version: '1', title: 'Current source', summary: 'Check the current original', source: 'fixture://current-guide',
  tenantId: 'tenant-a', labels: ['synthetic'], supportedKinds: ['lookup'], sha256: sha256(body), byteLength: Buffer.byteLength(body), requiredRules: ['Preserve current provenance'] };
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
class ProbedSource extends FileGuidanceSource {
  beforeProbe: ((signal?: AbortSignal) => Promise<void>) | null = null;
  afterProbe: (() => Promise<void>) | null = null;
  override async validate(value: GuidanceManifest, signal?: AbortSignal) { await this.beforeProbe?.(signal); const result = await super.validate(value, signal); await this.afterProbe?.(); return result; }
}
const limits = { callId: 'prepare', maxOutputTokens: 1000, maxInputBytes: 1000000, maxInputTokens: 1000000 };
async function setup(t: TestContext, backend: Adapter) {
  const directory = await mkdtemp(join(tmpdir(), 'guidance-source-current-')); const pack = join(directory, 'guidance'); await mkdir(pack);
  const writeManifest = (value: GuidanceManifest = manifest) => writeFile(join(pack, 'catalog.json'), JSON.stringify({ schemaVersion: 1, entries: [{ ...value, bodyFile: 'guide.md' }] }));
  await writeFile(join(pack, 'guide.md'), body); await writeManifest(); let repository = openRepository(backend, directory);
  t.after(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const seed = initial(workId); seed.policy.allowedTools = [...RESOURCE_TOOL_IDS]; seed.budget.limits.tokens = 1000000;
  assert.equal((await repository.commit(command(seed, 'seed'))).kind, 'committed');
  const requests: StructuredPlannerRequest[] = []; const clock = new FakeClock(1000); let beforeGet: (() => Promise<void>) | null = null;
  const compose = async () => {
    const source = new ProbedSource(pack);
    const state: StateRepository = new Proxy(repository, { get(target, key) {
      if (key === 'get') return async (id: string) => { const value = await target.get(id); await beforeGet?.(); return value; };
      const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const planner = new StructuredPlannerAdapter({ identity: { provider: 'fixture', model: 'source-recorder', revision: '1' }, destination: 'local',
      capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 1000000 } }, { invoke: async request => {
      requests.push(structuredClone(request)); return { finish: 'stop', content: JSON.stringify({ baseStateRevision: request.packet.stateRevision, baseGoalRevision: request.packet.goal.revision,
        basePlanRevision: request.packet.plan?.revision ?? 0, reason: 'Only a synthetic transport ran', tasks: [], hypotheses: request.packet.hypotheses }),
      usage: { inputTokens: 11, outputTokens: 7 }, provider: 'fixture', model: 'source-recorder' };
    } });
    const c = await composeRuntime({ services: { state, clock, artifacts: new FileArtifactStore(join(directory, 'artifacts')), planner, sink: new FakeSink(), tools: [],
      ids: new RandomIds(), digester: new Sha256Digester() }, schemas: new AjvSchemas(), guidanceSource: source, owner: 'source-owner' });
    return { ...c, source };
  };
  let c = await compose(); const current = await c.runtime.state(workId);
  const task: TaskSpec = { id: 'load-guide', description: 'Load original guidance', toolId: 'core.guidance.load', toolVersion: '1', effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [],
    input: { id: manifest.id, version: manifest.version, kind: 'lookup', reason: 'Prepare current guidance', maxBytes: 65536 } };
  await c.runtime.submitPlan(workId, 'load-plan', { baseStateRevision: current.revision, baseGoalRevision: 1, basePlanRevision: 0, reason: 'Read guidance first', tasks: [task], hypotheses: [] });
  const attempt = await c.runtime.reserve(workId, task.id); await c.runtime.execute(workId, attempt.id); await c.runtime.adopt(workId, attempt.id);
  assert.equal((await c.runtime.state(workId)).attempts[0]!.adopted, true); assert.ok(await repository.receipt(workId, `dispatch:${attempt.id}`));
  return { c: () => c, requests, clock, writeManifest, remove: () => unlink(join(pack, 'guide.md')), modify: () => writeFile(join(pack, 'guide.md'), 'X'.repeat(body.length)),
    removeStored: (ref: ArtifactRef) => unlink(join(directory, 'artifacts', `${ref.id}.blob`)),
    setBeforeGet: (hook: (() => Promise<void>) | null) => { beforeGet = hook; },
    restart: async () => { await repository.close(); repository = openRepository(backend, directory); c = await compose(); return c; } };
}
type Harness = Awaited<ReturnType<typeof setup>>;
async function notSent(h: Harness, callId: string, planning = h.c().planning!) {
  assert.equal(h.requests.length, 0); assert.equal(await planning.adopt(workId, callId), false);
  const current = await h.c().runtime.state(workId); const call = current.modelCalls.find(value => value.id === callId)!;
  assert.equal(call.status, 'rejected'); assert.equal(call.usageStatus, 'reported'); assert.equal(call.inputTokens, 0); assert.equal(call.outputTokens, 0);
  assert.equal(current.budget.used.tokens, 0); assert.equal(current.budget.reservedTokens, 0); assert.equal(current.budget.reservedModelCalls, 0);
  assert.equal(current.budget.used.modelCalls, 1); assert.equal(current.budget.used.unmeasuredModelCalls, 0);
}

test('legacy current validation reads original bytes and a fresh listing and accounts for each cost', async () => {
  let current = structuredClone(manifest); let text = body; let reads = 0; let lists = 0;
  const source: GuidanceSource = { list: async () => { lists++; return [structuredClone(current)]; }, read: async () => { reads++; return Buffer.from(text); } };
  const catalogue = await GuidanceCatalog.create(source); const artifacts = new MemoryArtifactStore(); const state = initial();
  assert.equal(await catalogue.validateCurrent(state, artifacts, manifest, { kind: 'lookup' }), true);
  assert.equal(reads, 1); assert.equal(lists, 2); assert.equal(catalogue.validationMetrics().legacyArtifactPuts, 1);
  assert.equal(catalogue.validationMetrics().legacyReadBytes, Buffer.byteLength(body)); assert.ok(catalogue.validationMetrics().legacyListingBytes > 0);
  current = { ...current, requiredRules: ['Changed without refresh'] };
  assert.equal(await catalogue.validateCurrent(state, artifacts, manifest), false);
  current = structuredClone(manifest); text = 'X'.repeat(body.length);
  assert.equal(await catalogue.validateCurrent(state, artifacts, manifest), false); assert.equal(reads, 3);
  const metrics = catalogue.validationMetrics(); assert.equal(metrics.calls, 3); assert.equal(metrics.legacyReadCalls, 3); assert.equal(metrics.legacyListingCalls, 2);
  assert.equal(metrics.legacyArtifactPuts, 3); assert.equal(catalogue.metrics().bodyDecodes, 0);
});

test('legacy cold load compares a fresh manifest without duplicating the original read', async () => {
  let current = structuredClone(manifest); let reads = 0;
  const source: GuidanceSource = { list: async () => [structuredClone(current)], read: async () => { reads++; current = { ...current, supportedKinds: ['compare'] }; return Buffer.from(body); } };
  const catalogue = await GuidanceCatalog.create(source);
  await assert.rejects(catalogue.load(initial(), new MemoryArtifactStore(), { id: manifest.id, version: '1', kind: 'lookup', reason: 'Check live applicability', maxBytes: 65536 }), /guidance_source_changed/);
  assert.equal(reads, 1); assert.equal(catalogue.validationMetrics().legacyReadCalls, 0); assert.equal(catalogue.validationMetrics().legacyListingCalls, 1);
});

test('a cancelled current probe makes no original read and a failed fresh listing is not accepted', async () => {
  let reads = 0; let fail = false;
  const source: GuidanceSource = { list: async () => { if (fail) throw new Error('unavailable'); return [structuredClone(manifest)]; }, read: async () => { reads++; return Buffer.from(body); } };
  const catalogue = await GuidanceCatalog.create(source); const control = new AbortController(); control.abort();
  assert.equal(await catalogue.validateCurrent(initial(), new MemoryArtifactStore(), manifest, { signal: control.signal }), false); assert.equal(reads, 0);
  fail = true; assert.equal(await catalogue.validateCurrent(initial(), new MemoryArtifactStore(), manifest), false); assert.equal(reads, 1);
});

for (const backend of adapters) {
  for (const change of ['delete', 'modify', 'rules'] as const) test(`${backend}: context compilation refuses ${change} in an original guidance source`, async t => {
    const h = await setup(t, backend); if (change === 'delete') await h.remove(); else if (change === 'modify') await h.modify();
    else await h.writeManifest({ ...manifest, requiredRules: ['Changed source rule'] });
    await assert.rejects(h.c().context.prepare(await h.c().runtime.state(workId), limits), /context_guidance_unavailable/); assert.equal(h.requests.length, 0);
  });

  for (const change of ['delete', 'modify'] as const) test(`${backend}: restarted stored model input cannot send a ${change}d original guide`, async t => {
    const h = await setup(t, backend); const call = await h.c().planning!.reserve(workId); const before = await h.c().runtime.state(workId);
    const envelope = JSON.parse(new TextDecoder().decode(await h.c().services.artifacts.get(call.inputArtifact, before.policy))) as { packet: ContextPacket; options: ModelCallOptions };
    assert.equal(envelope.packet.activeGuidance?.length, 1);
    if (change === 'delete') await h.remove(); else await h.modify(); await h.restart();
    assert.deepEqual(await h.c().runtime.state(workId), before); await h.c().planning!.execute(workId, call.id); await notSent(h, call.id);
  });

  for (const change of ['policy', 'goal', 'cancel'] as const) test(`${backend}: ${change} during original-source validation stops transport and settles zero usage`, { timeout: 10000 }, async t => {
    const h = await setup(t, backend); const call = await h.c().planning!.reserve(workId); const started = gate<void>(); const release = gate<void>();
    t.after(() => release.resolve()); let observedSignal: AbortSignal | undefined;
    h.c().source.beforeProbe = async signal => { observedSignal = signal; started.resolve(); await release.promise; };
    const pending = h.c().planning!.execute(workId, call.id); await started.promise; const state = await h.c().runtime.state(workId);
    if (change === 'policy') await transact(h.c().services, workId, 'revoke', 'policy_changed', {}, next => { next.policy.allowedLabels = []; });
    else if (change === 'goal') await h.c().runtime.command(workId, 'new-goal', state.policy, 1, { kind: 'goal', expectedControlRevision: state.executionControl?.revision ?? 1, goal: { ...state.goal, revision: 2, scope: 'changed-scope' } });
    else await h.c().runtime.command(workId, 'cancel', state.policy, 1, { kind: 'cancel', reason: 'Cancel before transmission' });
    release.resolve(); await pending; await notSent(h, call.id); if (change !== 'policy') assert.equal(observedSignal?.aborted, true);
  });

  test(`${backend}: manifest refresh after the source probe is caught after final state lookup`, async t => {
    const h = await setup(t, backend); const call = await h.c().planning!.reserve(workId); let changed = false;
    h.c().source.afterProbe = async () => { h.setBeforeGet(async () => { h.setBeforeGet(null); changed = true;
      await h.writeManifest({ ...manifest, requiredRules: ['Changed after source validation'] }); await h.c().guidance.refresh(); }); };
    await h.c().planning!.execute(workId, call.id); assert.equal(changed, true); await notSent(h, call.id);
  });

  test(`${backend}: an ignored-signal original probe is stopped by the remaining model lease`, { timeout: 5000 }, async t => {
    const h = await setup(t, backend); const c = h.c(); const planning = new PlanningRuntime(c.services, c.contracts, c.runtime, 'source-owner', { leaseMs: 200 }, c.context);
    const call = await planning.reserve(workId); let observedSignal: AbortSignal | undefined;
    c.source.beforeProbe = async signal => { observedSignal = signal; await new Promise<void>(() => undefined); };
    await planning.execute(workId, call.id); assert.equal(observedSignal?.aborted, true); await notSent(h, call.id, planning);
  });

  test(`${backend}: stored guidance loss during source probe blocks transport and prevents settlement until repair`, async t => {
    const h = await setup(t, backend); const c = h.c(); const call = await c.planning!.reserve(workId); const before = await c.runtime.state(workId);
    const envelope = JSON.parse(new TextDecoder().decode(await c.services.artifacts.get(call.inputArtifact, before.policy))) as { packet: ContextPacket; options: ModelCallOptions };
    const ref = envelope.packet.activeGuidance![0]!.artifact; const original = await c.services.artifacts.get(ref, before.policy); let removed = false;
    c.source.afterProbe = async () => { c.source.afterProbe = null; await h.removeStored(ref); removed = true; };
    await assert.rejects(c.planning!.execute(workId, call.id), /artifact_unavailable/);
    assert.equal(removed, true); assert.equal(h.requests.length, 0); assert.equal(await c.services.artifacts.exists(ref), false);
    assert.equal(new TextDecoder().decode(await c.source.read(manifest.id, manifest.version)), body, 'the provider original remains valid');
    const blocked = await c.runtime.state(workId); const unsettled = blocked.modelCalls.find(value => value.id === call.id)!;
    assert.equal(unsettled.status, 'running'); assert.equal(unsettled.replyArtifact, null); assert.equal(unsettled.usageStatus, 'reserved');
    assert.equal(blocked.budget.used.modelCalls, 1); assert.equal(blocked.budget.used.tokens, 0); assert.equal(blocked.budget.reservedTokens, call.tokenReservation);
    assert.equal(await c.services.state.receipt(workId, `model-receive:${call.id}`), null, 'no cancellation settlement was committed while a required artifact was absent');
    const repaired = await c.services.artifacts.put(original, { tenantId: ref.tenantId, labels: ref.labels, mediaType: ref.mediaType }); assert.deepEqual(repaired, ref);
    await c.planning!.receive(workId, call.id, { status: 'cancelled', code: 'model_not_sent', inputTokens: 0, outputTokens: 0 });
    await notSent(h, call.id);
  });

  test(`${backend}: unchanged original guidance sends the exact stored request once after restart`, async t => {
    const h = await setup(t, backend); const call = await h.c().planning!.reserve(workId); const state = await h.c().runtime.state(workId);
    const envelope = JSON.parse(new TextDecoder().decode(await h.c().services.artifacts.get(call.inputArtifact, state.policy))) as { packet: ContextPacket; options: ModelCallOptions };
    await h.restart(); await h.c().planning!.execute(workId, call.id); assert.equal(h.requests.length, 1);
    assert.deepEqual(h.requests[0]!.packet, envelope.packet); assert.deepEqual(h.requests[0]!.options, envelope.options);
    assert.equal(await h.c().planning!.adopt(workId, call.id), true); assert.equal((await h.c().runtime.state(workId)).budget.used.tokens, 18);
  });
}
