import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactStore, StateRepository } from '../application/ports.js';
import type { ContextHead } from '../domain/context.js';
import type { KnowledgeDependency } from '../domain/knowledge.js';
import type { WorkState } from '../domain/model.js';
import { ContextFrameStore } from '../application/context-store.js';
import { ContextFrameSchema, type ContextFrame } from '../application/context-contracts.js';
import { buildContextPacket } from '../application/context-packet.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { asJson } from '../application/plan-validator.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { adapters, advance, attempt, command, initial, openRepository } from './state-conformance-helpers.js';

const digester = new Sha256Digester(); const hash = 'a'.repeat(64);
const contracts = new ToolContracts([], new AjvSchemas());
const dependency: KnowledgeDependency = { tenantId: 'tenant-a', knowledgeId: 'synthetic-memory', knowledgeRevision: 1, actorDigest: hash,
  sources: [{ workId: 'source-work', evidenceId: 'source', sourceVersion: hash, generation: 0, workRevision: 1, policyDigest: hash }], parents: [] };
function frame(state: WorkState): ContextFrame {
  const packet = buildContextPacket(state, contracts); const packetBytes = Buffer.byteLength(JSON.stringify(packet));
  return ContextFrameSchema.parse({ schemaVersion: 1, kind: 'model_context',
    basis: { workId: state.id, stateRevision: state.revision, goalRevision: state.goal.revision, planRevision: state.plan?.revision ?? 0,
      eventCursor: 1, policyDigest: digester.digest(asJson(state.policy)), dataGeneration: state.dataLifecycle?.generation ?? 0, toolsDigest: digester.digest([]), knowledgeDigest: digester.digest([]) },
    packet, tools: [], decisions: [], memo: { cycle: 1, mode: 'full', entries: [], evictions: 0, reloads: 0 }, protectedDigest: hash,
    metrics: { baselinePacketBytes: packetBytes, baselineToolBytes: 2, packetBytes, toolBytes: 2, envelopeBytes: 2, requestBytes: packetBytes + 4,
      estimatedTokens: packetBytes + 4, estimateMethod: 'synthetic-byte-count', outputTokenReservation: 100, sourceReads: 0, extraModelCalls: 0, evictions: 0, reloads: 0 } });
}
function artifactPort(backing: ArtifactStore, overrides: Partial<ArtifactStore>): ArtifactStore {
  return { put: backing.put.bind(backing), get: backing.get.bind(backing), exists: backing.exists.bind(backing), ...overrides };
}
async function setup(directory: string, states: StateRepository = new MemoryStateRepository(), withKnowledge = false) {
  const state = initial(); if (withKnowledge) state.attempts = [{ ...attempt('succeeded', 0), adopted: true, finishedAt: 1001, knowledgeDependencies: [dependency] }];
  assert.equal((await states.commit(command(state, 'seed'))).kind, 'committed');
  const artifacts = new FileArtifactStore(join(directory, 'artifacts')); const access = { current: true }; let serial = 0;
  const services = { state: states, artifacts, digester, knowledge: { validate: async () => access.current } };
  const store = new ContextFrameStore(services);
  const mutate = async (edit: (state: WorkState) => void) => {
    const next = advance((await states.get(state.id))!); edit(next);
    assert.equal((await states.commit(command(next, `mutation-${++serial}`))).kind, 'committed'); return next;
  };
  const install = async (head: ContextHead) => mutate(next => { next.contextHead = structuredClone(head); });
  return { state, states, services, artifacts, access, store, mutate, install, make: (port: ArtifactStore) => new ContextFrameStore({ ...services, artifacts: port }) };
}
async function fixture(run: (value: Awaited<ReturnType<typeof setup>>, directory: string) => Promise<void>, withKnowledge = false) {
  const directory = await mkdtemp(join(tmpdir(), 'context-store-')); const f = await setup(directory, undefined, withKnowledge);
  try { await run(f, directory); } finally { await f.states.close(); await rm(directory, { recursive: true, force: true }); }
}

test('context store stages an immutable frame without publishing it and reads the installed basis N from revision N+1', async () => {
  await fixture(async f => {
    assert.deepEqual(await f.store.previous(f.state), { frame: null, disposition: 'none' });
    const candidate = frame(f.state); candidate.packet.policy.allowedTools = [];
    const head = await f.store.stage(f.state, candidate);
    assert.deepEqual(await f.states.get(f.state.id), f.state); assert.equal(head.basisRevision, f.state.revision); assert.equal(head.cycle, candidate.memo.cycle);
    assert.equal(f.state.artifacts.length, 0); assert.equal(f.state.contextHead, undefined);
    const installed = await f.install(head); const previous = await f.store.previous(installed);
    assert.equal(previous.disposition, 'usable'); assert.deepEqual(previous.frame, candidate);
    assert.equal(installed.artifacts.length, 0);
    const replanned = await f.mutate(next => { next.plan = { revision: 1, goalRevision: next.goal.revision, reason: 'A new plan may reuse memo hints', tasks: [] }; });
    assert.equal((await f.store.previous(replanned)).disposition, 'usable');
  });
});

for (const backend of adapters) test(`context store ${backend}: derived frame and installed head survive separate reopened instances`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-store-reopen-')); let states = openRepository(backend, directory);
  try {
    const f = await setup(directory, states); const candidate = frame(f.state); const head = await f.store.stage(f.state, candidate); await f.install(head);
    await states.close(); states = openRepository(backend, directory);
    const reopened = new ContextFrameStore({ state: states, artifacts: new FileArtifactStore(join(directory, 'artifacts')), digester });
    assert.deepEqual(await reopened.previous((await states.get(f.state.id))!), { frame: candidate, disposition: 'usable' });
  } finally { await states.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const damage of ['missing', 'corrupt', 'invalid-json', 'invalid-schema'] as const) test(`context store regenerates a ${damage} derived frame without editing the authoritative head`, async () => {
  await fixture(async (f, directory) => {
    let head = await f.store.stage(f.state, frame(f.state));
    if (damage === 'invalid-json' || damage === 'invalid-schema') {
      const artifact = await f.artifacts.put(Buffer.from(damage === 'invalid-json' ? '{invalid' : JSON.stringify({ ...frame(f.state), undeclared: true })),
        { tenantId: f.state.policy.tenantId, labels: f.state.policy.allowedLabels, mediaType: 'application/json' });
      head = { ...head, artifact };
    }
    const installed = await f.install(head); const path = join(directory, 'artifacts', `${head.artifact.id}.blob`);
    if (damage === 'missing') await rm(path);
    if (damage === 'corrupt') { const bytes = await readFile(path); bytes[0] = 0; await writeFile(path, bytes); }
    assert.deepEqual(await f.store.previous(installed), { frame: null, disposition: 'regenerated' });
    assert.deepEqual(await f.states.get(f.state.id), installed);
  });
});

for (const invalid of ['foreign-work', 'foreign-tenant', 'cycle', 'basis', 'unpublished', 'policy', 'goal', 'generation', 'blocked', 'underlabelled'] as const) {
  test(`context store excludes a ${invalid} previous head or frame`, async () => {
    await fixture(async f => {
      const candidate = frame(f.state); let head = await f.store.stage(f.state, candidate);
      if (invalid === 'foreign-work') {
        candidate.basis.workId = 'other-work'; candidate.packet.workId = 'other-work';
        head.artifact = await f.artifacts.put(Buffer.from(JSON.stringify(candidate)), { tenantId: f.state.policy.tenantId, labels: f.state.policy.allowedLabels, mediaType: 'application/json' });
      }
      if (invalid === 'foreign-tenant') head.artifact.tenantId = 'other-tenant';
      if (invalid === 'cycle') head.cycle++;
      if (invalid === 'basis') head.basisRevision = 2;
      if (invalid === 'underlabelled') head.artifact = await f.artifacts.put(Buffer.from(JSON.stringify(candidate)), { tenantId: f.state.policy.tenantId, labels: [], mediaType: 'application/json' });
      let installed = await f.install(head);
      if (invalid === 'unpublished') installed = await f.mutate(next => { next.contextHead!.basisRevision = next.revision; });
      if (invalid === 'policy') installed = await f.mutate(next => { next.policy.allowedLabels = []; });
      if (invalid === 'goal') installed = await f.mutate(next => { next.goal = { ...next.goal, revision: next.goal.revision + 1 }; });
      if (invalid === 'generation' || invalid === 'blocked') installed = await f.mutate(next => { next.dataLifecycle = { generation: 1, blockedArtifactIds: invalid === 'blocked' ? [head.artifact.id] : [], changes: [] }; });
      assert.deepEqual(await f.store.previous(installed), { frame: null, disposition: 'regenerated' });
    });
  });
}

test('context store checks stale frame basis and forbidden packet policy before writing any candidate', async () => {
  await fixture(async f => {
    let writes = 0; const store = f.make(artifactPort(f.artifacts, { put: async (...args) => { writes++; return f.artifacts.put(...args); } }));
    const edits: ((frame: ContextFrame) => void)[] = [
      value => { value.basis.workId = 'other-work'; }, value => { value.basis.stateRevision++; }, value => { value.basis.goalRevision++; },
      value => { value.basis.planRevision++; }, value => { value.basis.policyDigest = 'b'.repeat(64); }, value => { value.basis.dataGeneration++; },
      value => { value.packet.stateRevision++; }, value => { value.packet.goal.description = 'Changed goal'; },
      value => { value.packet.policy.allowedTools.push('forbidden.tool'); }, value => { value.packet.policy.allowWrites = true; },
    ];
    for (const edit of edits) { const candidate = frame(f.state); edit(candidate); await assert.rejects(store.stage(f.state, candidate), /context_state_changed/); }
    await assert.rejects(store.stage(f.state, { ...frame(f.state), undeclared: true } as never), /context_frame_invalid/);
    assert.equal(writes, 0); assert.deepEqual(await f.states.get(f.state.id), f.state);
  });
});

for (const operation of ['previous', 'put', 'readback'] as const) for (const change of ['goal', 'policy', 'generation', 'source'] as const) {
  test(`context store ${operation} rejects ${change} changes during artifact I/O`, async () => {
    await fixture(async f => {
      let state = f.state; if (operation === 'previous') state = await f.install(await f.store.stage(state, frame(state)));
      let triggered = false;
      const alter = async () => {
        if (triggered) return; triggered = true;
        if (change === 'source') f.access.current = false;
        else await f.mutate(next => {
          if (change === 'goal') next.goal.revision++;
          if (change === 'policy') next.policy.allowedLabels = [];
          if (change === 'generation') next.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] };
        });
      };
      const port = artifactPort(f.artifacts, {
        put: async (...args) => { const ref = await f.artifacts.put(...args); if (operation === 'put') await alter(); return ref; },
        get: async (...args) => { const bytes = await f.artifacts.get(...args); if (operation !== 'put') await alter(); return bytes; },
      });
      const store = f.make(port);
      await assert.rejects(operation === 'previous' ? store.previous(state) : store.stage(state, frame(state)), /context_state_changed/);
      assert.equal(triggered, true); assert.deepEqual((await f.states.get(state.id))!.contextHead, state.contextHead);
    }, true);
  });
}

test('context store never turns state or source failure during a missing-frame read into successful regeneration', async () => {
  await fixture(async f => {
    const installed = await f.install(await f.store.stage(f.state, frame(f.state)));
    const store = f.make(artifactPort(f.artifacts, { get: async () => { f.access.current = false; throw new Error('artifact_unavailable'); } }));
    await assert.rejects(store.previous(installed), /context_state_changed/);
  }, true);
});

test('context store refuses unavailable knowledge even when there is no previous head', async () => {
  await fixture(async f => {
    const missing = new ContextFrameStore({ state: f.states, artifacts: f.artifacts, digester });
    await assert.rejects(missing.previous(f.state), /context_state_changed/);
    await assert.rejects(missing.stage(f.state, frame(f.state)), /context_state_changed/);
    f.access.current = false; await assert.rejects(f.store.previous(f.state), /context_state_changed/);
  }, true);
});

test('context store leaves the previous head intact when candidate storage fails', async () => {
  await fixture(async f => {
    const installed = await f.install(await f.store.stage(f.state, frame(f.state)));
    const store = f.make(artifactPort(f.artifacts, { put: async () => { throw new Error('synthetic_put_failed'); } }));
    await assert.rejects(store.stage(installed, frame(installed)), /synthetic_put_failed/);
    assert.deepEqual(await f.states.get(f.state.id), installed); assert.equal((await f.store.previous(installed)).disposition, 'usable');
  });
});

test('context store rejects a relabelled put receipt or altered readback bytes and never publishes a head', async () => {
  await fixture(async f => {
    const relabelled = f.make(artifactPort(f.artifacts, { put: async (...args) => ({ ...await f.artifacts.put(...args), labels: [] }) }));
    await assert.rejects(relabelled.stage(f.state, frame(f.state)), /context_artifact_invalid/);
    const altered = f.make(artifactPort(f.artifacts, { get: async (...args) => { const bytes = await f.artifacts.get(...args); bytes[0] = bytes[0]! ^ 1; return bytes; } }));
    await assert.rejects(altered.stage(f.state, frame(f.state)), /context_artifact_invalid/);
    assert.deepEqual(await f.states.get(f.state.id), f.state);
  });
});

test('context store applies byte limits before writing or loading a derived frame', async () => {
  await fixture(async f => {
    for (const limit of [0, -1, Infinity, 1.5]) assert.throws(() => new ContextFrameStore(f.services, limit), /invalid_context_store_limit/);
    let writes = 0; let reads = 0;
    const limited = new ContextFrameStore({ ...f.services, artifacts: artifactPort(f.artifacts, {
      put: async (...args) => { writes++; return f.artifacts.put(...args); }, get: async (...args) => { reads++; return f.artifacts.get(...args); },
    }) }, 128);
    await assert.rejects(limited.stage(f.state, frame(f.state)), /context_frame_too_large/); assert.equal(writes, 0);
    const installed = await f.install(await f.store.stage(f.state, frame(f.state)));
    assert.deepEqual(await limited.previous(installed), { frame: null, disposition: 'regenerated' }); assert.equal(reads, 0);
  });
});
