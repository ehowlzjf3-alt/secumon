import test from 'node:test';
import assert from 'node:assert/strict';
import { BoardWorkSourceRegistry } from '../application/board-work-source-registry.js';
import type { BoardWorkSource } from '../application/board-work-sources.js';
import type { SourceInputInspection } from '../application/source-input-inspection.js';
import type { TrustedKnowledgeActor } from '../domain/knowledge.js';
import { initial, artifact } from './state-conformance-helpers.js';

const work = initial(), owner = { tenantId: work.policy.tenantId, principalId: work.policy.principalId };
const identity = { ...owner, workId: work.id };
const actor: TrustedKnowledgeActor = { ...owner, allowedLabels: ['synthetic'], allowedScopes: ['fixture'],
  allowedNamespaces: ['team'], canPublish: true, canReview: false };
function fixture(id: string, principalId = owner.principalId) {
  const state = structuredClone(work); state.policy.principalId = principalId;
  const inspection: SourceInputInspection = { version: 'fixture', sourceWorkIds: [], knowledgeDependencies: [], bytesRead: 0,
    current: async () => true };
  const observed = { stateReads: 0, inspections: 0 };
  const inspect = async () => { observed.inspections++; return inspection; };
  const source: BoardWorkSource = { inputs: { id, state: { get: async key => { observed.stateReads++; return key === state.id ? structuredClone(state) : null; } },
    authority: { resolve: async expected => expected.tenantId === owner.tenantId && expected.principalId === principalId ? { ...actor, principalId } : null },
    inspectInput: inspect, inspectMemory: inspect, inspectCoverage: inspect, effectsCurrent: async () => true },
    artifacts: { get: async () => new Uint8Array(), exists: async () => false }, current: async () => true };
  return { source, observed, inspection };
}

test('board source registry resolves only explicitly registered matching owners and verifies the returned work owner', async () => {
  const registry = new BoardWorkSourceRegistry(), own = fixture('own'), foreign = fixture('foreign', 'someone-else'), mismatch = fixture('mismatch', 'wrong-owner');
  registry.register(owner, own.source); registry.register({ ...owner, principalId: 'someone-else' }, foreign.source);
  registry.register(owner, mismatch.source);
  const selected = await registry.resolve(identity); assert.ok(selected); assert.equal(selected.inputs.id, 'own');
  assert.equal(foreign.observed.stateReads, 0); assert.equal(own.observed.stateReads, 1); assert.equal(mismatch.observed.stateReads, 1);
  assert.equal(await registry.resolve({ ...identity, tenantId: 'other-tenant' }), null);
  assert.equal(await registry.resolve({ ...identity, workId: 'absent' }), null);
  assert.equal(selected.inputs.identity, own.source.inputs);
});

test('board source registry rejects duplicate registrations and ambiguous work IDs rather than selecting the first store', async () => {
  const registry = new BoardWorkSourceRegistry(), a = fixture('a'), b = fixture('b');
  const removeA = registry.register(owner, a.source);
  assert.throws(() => registry.register(owner, fixture('a').source), /board_source_registration_invalid/);
  registry.register(owner, b.source); await assert.rejects(registry.resolve(identity), /board_source_ambiguous/);
  removeA(); assert.equal((await registry.resolve(identity))?.inputs.id, 'b');
});

test('repeated cleanup of an old board source cannot remove its replacement or revive the retired handle', async () => {
  const registry = new BoardWorkSourceRegistry(), old = fixture('same'), replacement = fixture('same');
  const unregister = registry.register(owner, old.source), retired = await registry.resolve(identity); assert.ok(retired);
  unregister(); const removeReplacement = registry.register(owner, replacement.source); unregister();
  const live = await registry.resolve(identity); assert.ok(live); assert.equal(live.inputs.identity, replacement.source.inputs);
  await assert.rejects(retired.inputs.state.get(work.id), /board_source_unregistered/);
  await assert.rejects(retired.current(work), /board_source_unregistered/);
  assert.equal(await live.current(work), true); removeReplacement(); assert.equal(await registry.resolve(identity), null);
});

for (const operation of ['inspectInput', 'inspectMemory', 'inspectCoverage'] as const) {
  test(`board source ${operation} discards a response arriving after host unregister`, async () => {
    const registry = new BoardWorkSourceRegistry(), f = fixture(operation);
    let enter!: () => void, release!: (value: SourceInputInspection) => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const response = new Promise<SourceInputInspection>(resolve => { release = resolve; });
    f.source.inputs[operation] = async () => { f.observed.inspections++; enter(); return response; };
    const unregister = registry.register(owner, f.source), selected = await registry.resolve(identity); assert.ok(selected);
    const signal = new AbortController().signal;
    const pending = operation === 'inspectInput' ? selected.inputs.inspectInput({ provider: 'fixture', workId: work.id, artifact: artifact() }, work, actor, signal)
      : operation === 'inspectMemory' ? selected.inputs.inspectMemory([], actor, signal, work) : selected.inputs.inspectCoverage(work);
    const rejected = assert.rejects(pending, /board_source_unregistered/);
    await entered; unregister(); release(f.inspection); await rejected;
    assert.equal(f.observed.inspections, 1); assert.equal(await registry.resolve(identity), null);
  });
}
