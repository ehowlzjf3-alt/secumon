import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextHead } from '../domain/context.js';
import type { Evidence, WorkState } from '../domain/model.js';
import { artifactBlocked } from '../domain/data-lifecycle.js';
import { commitWithArtifacts } from '../application/commit-artifacts.js';
import { ContextFrameStore } from '../application/context-store.js';
import { ContextRecovery } from '../application/context-recovery.js';
import { DataLifecycleService } from '../application/data-lifecycle.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FakeClock } from '../infrastructure/fakes.js';
import { adapters, advance, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const publicationEvents = ['model_call_reserved', 'context_compacted'] as const;
const actor = { tenantId: 'tenant-a', principalId: 'person-a' };
const contracts = new ToolContracts([], new AjvSchemas());

async function fixture(adapter: Adapter) {
  const directory = await mkdtemp(join(tmpdir(), 'context-lifecycle-'));
  const state = openRepository(adapter, directory); const artifactDirectory = join(directory, 'artifacts');
  const artifacts = new FileArtifactStore(artifactDirectory);
  const services = { state, artifacts, clock: new FakeClock(2000), digester: new Sha256Digester() };
  const original = await artifacts.put(Buffer.from('synthetic original'), { tenantId: actor.tenantId, labels: ['synthetic'], mediaType: 'text/plain' });
  const derived = await artifacts.put(Buffer.from('{"synthetic":"derived context"}'), { tenantId: actor.tenantId, labels: ['synthetic'], mediaType: 'application/json' });
  const evidence: Evidence = { id: 'source', tenantId: actor.tenantId, scope: 'fixture', sourceId: 'synthetic-source', lineageId: 'synthetic-lineage', locator: 'fixture:source',
    observedAt: 1000, recordedAt: 1000, labels: ['synthetic'], coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [], facts: { available: true }, artifact: original };
  const seed = initial(); seed.artifacts = [original]; seed.evidence = [evidence];
  assert.equal((await commitWithArtifacts(state, artifacts, command(seed, 'seed'))).kind, 'committed');
  let serial = 0;
  const commit = async (next: WorkState, type: string) => {
    const request = command(next, `change-${++serial}`); request.events[0]!.type = type;
    return commitWithArtifacts(state, artifacts, request);
  };
  const install = async (type: string = 'context_compacted') => {
    const prior = (await state.get(seed.id))!; const next = advance(prior);
    next.contextHead = { artifact: derived, basisRevision: prior.revision, cycle: 1 };
    assert.equal((await commit(next, type)).kind, 'committed'); return next;
  };
  return { directory, artifactDirectory, services, state, artifacts, seed, original, derived, evidence, commit, install,
    close: async () => { await state.close(); await rm(directory, { recursive: true, force: true }); } };
}

for (const adapter of adapters) {
  for (const type of publicationEvents) test(`${adapter}/${type}: publishing requires the derived blob, later loss permits commits and regeneration while original loss blocks both`, async () => {
    const f = await fixture(adapter);
    try {
      const installed = await f.install(type); assert.equal(installed.artifacts.some(ref => ref.id === f.derived.id), false);
      await rm(join(f.artifactDirectory, `${f.derived.id}.blob`));
      const after = advance(installed); assert.equal((await f.commit(after, 'state_changed')).kind, 'committed');
      assert.deepEqual(await new ContextFrameStore(f.services).previous(after), { frame: null, disposition: 'regenerated' });
      const recovery = new ContextRecovery(f.services, contracts);
      const restored = await recovery.restore(after.id, actor);
      assert.deepEqual(restored.packet.runtime.artifacts.map(ref => ref.id), [f.original.id]);
      const retry = advance(after); retry.contextHead = { artifact: f.derived, basisRevision: after.revision, cycle: 2 };
      await assert.rejects(f.commit(retry, type), /artifact_unavailable/);
      assert.deepEqual(await f.state.get(after.id), after);
      await rm(join(f.artifactDirectory, `${f.original.id}.blob`));
      await assert.rejects(f.commit(advance(after), 'state_changed'), /artifact_unavailable/);
      await assert.rejects(recovery.restore(after.id, actor), /resume_original_unavailable/);
      assert.deepEqual(await f.state.get(after.id), after);
    } finally { await f.close(); }
  });

  test(`${adapter}: publishing detects a context head reference conflict before committing`, async () => {
    const f = await fixture(adapter);
    try {
      for (const type of publicationEvents) {
        const next = advance(f.seed);
        next.contextHead = { artifact: { ...f.original, labels: [] }, basisRevision: f.seed.revision, cycle: 1 };
        await assert.rejects(f.commit(next, type), /artifact_reference_conflict/);
        assert.deepEqual(await f.state.get(f.seed.id), f.seed);
      }
    } finally { await f.close(); }
  });

  test(`${adapter}: a blocked context candidate cannot be newly published even when its bytes remain`, async () => {
    const f = await fixture(adapter);
    try {
      for (const type of publicationEvents) {
        const next = advance(f.seed); next.contextHead = { artifact: f.derived, basisRevision: f.seed.revision, cycle: 1 };
        next.dataLifecycle = { generation: 1, blockedArtifactIds: [f.derived.id], changes: [] };
        assert.equal(await f.artifacts.exists(f.derived), true);
        await assert.rejects(f.commit(next, type), /artifact_unavailable/);
        assert.deepEqual(await f.state.get(f.seed.id), f.seed);
      }
    } finally { await f.close(); }
  });

  for (const action of ['retract', 'correct', 'restrict', 'delete', 'dependency_changed'] as const) {
    test(`${adapter}/${action}: lifecycle retires the context head and access removal also blocks its retained artifact`, async () => {
      const f = await fixture(adapter);
      try {
        const installed = await f.install(); const head: ContextHead = installed.contextHead!;
        const lifecycle = new DataLifecycleService(f.services);
        if (action === 'dependency_changed') await lifecycle.invalidateKnowledge(installed.id, installed.revision);
        else await lifecycle.change(installed.id, actor, `lifecycle-${action}`, { action, evidenceIds: [f.evidence.id], expectedGeneration: 0, reason: 'Synthetic content lifecycle change',
          replacement: action === 'correct' ? { ...f.evidence, id: 'replacement', observedAt: 1001, recordedAt: 1001, supersedes: [f.evidence.id] } : null });
        const current = (await f.state.get(installed.id))!;
        assert.equal(current.contextHead, null); assert.equal(current.dataLifecycle!.generation, 1);
        assert.equal(artifactBlocked(current, head.artifact), ['restrict', 'delete', 'dependency_changed'].includes(action));
        assert.equal(current.artifacts.some(ref => ref.id === head.artifact.id), false);
        assert.equal(await f.artifacts.exists(head.artifact), true);
        assert.deepEqual(await new ContextFrameStore(f.services).previous(current), { frame: null, disposition: 'none' });
      } finally { await f.close(); }
    });
  }
}
