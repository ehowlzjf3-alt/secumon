import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Evidence, ToolResult, WorkState } from '../domain/model.js';
import type { KnowledgeDependency, KnowledgeRecord, TrustedKnowledgeActor } from '../domain/knowledge.js';
import type { KnowledgeRepository } from '../application/knowledge-ports.js';
import type { StateRepository } from '../application/ports.js';
import { KnowledgeService } from '../application/knowledge-service.js';
import { createKnowledgeTools } from '../application/knowledge-tools.js';
import { SqliteKnowledgeRepository } from '../infrastructure/sqlite-knowledge.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { FakeClock } from '../infrastructure/fakes.js';
import { advance, artifact, attempt, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const actor = (principalId = 'person-a'): TrustedKnowledgeActor => ({ tenantId: 'tenant-a', principalId, allowedLabels: ['synthetic'],
  allowedNamespaces: ['team'], allowedScopes: ['fixture'], canReview: false, canPublish: true });
const original = (workId: string): Evidence => ({ id: `e-${workId}`, tenantId: 'tenant-a', scope: 'fixture', sourceId: workId, lineageId: workId,
  locator: `fixture://${workId}`, observedAt: 1000, recordedAt: 1000, labels: ['synthetic'], coverage: 'complete', status: 'accepted', access: 'available',
  supersedes: [], derivedFrom: [], facts: { available: true }, artifact: null });
const input = (id: string, workId: string, expiresAt: number | null = null) => ({ id, commandId: `create-${id}`, namespace: 'team', scope: 'fixture',
  kind: 'fact' as const, title: `Custody ${id}`, body: `Synthetic remembered ${id}`, labels: [], sources: [{ workId, evidenceId: `e-${workId}` }], expiresAt });

async function fixture(t: TestContext, backend: Adapter) {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-custody-'));
  const states = openRepository(backend, directory); const repository = new SqliteKnowledgeRepository(join(directory, 'knowledge.sqlite'));
  t.after(async () => { await repository.close(); await states.close(); await rm(directory, { recursive: true, force: true }); });
  const clock = new FakeClock(1100); const digester = new Sha256Digester(); let current = actor(); let serial = 0;
  const actors = { async current() { return structuredClone(current); } };
  const make = (statePort: StateRepository = states, knowledgePort: KnowledgeRepository = repository) =>
    new KnowledgeService({ states: statePort, repository: knowledgePort, actors, clock, digester });
  const service = make();
  for (const id of ['W', 'X']) { const state = initial(id); state.evidence = [original(id)]; assert.equal((await states.commit(command(state, `seed-${id}`))).kind, 'committed'); }
  const edit = async (id: string, change: (state: WorkState) => void) => {
    const next = advance((await states.get(id))!); change(next);
    assert.equal((await states.commit(command(next, `edit-${++serial}`))).kind, 'committed');
  };
  const retain = async (id: string, dependencies: KnowledgeDependency[]) => edit(id, state => {
    for (let offset = 0; offset < dependencies.length; offset += 50) state.attempts.push({ ...attempt('succeeded'),
      id: `retained-${state.revision}-${offset}`, adopted: true, finishedAt: 1000, knowledgeDependencies: dependencies.slice(offset, offset + 50) });
  });
  const promote = async (id: string) => {
    await service.submitForReview({ id, expectedRevision: 1, commandId: `submit-${id}`, reason: 'Synthetic explicit publication' });
    current = { ...actor('reviewer'), canReview: true };
    await service.reviewAndPromote({ id, expectedRevision: 2, expectedContentRevision: 1, commandId: `promote-${id}`, reason: 'Review exact source version' });
    current = actor();
  };
  const counted = (transform?: (record: KnowledgeRecord | null) => Promise<KnowledgeRecord | null>) => {
    const counts = { works: 0, records: 0 };
    const workPort = new Proxy(states, { get(target, key) {
      if (key === 'get') return async (id: string) => { counts.works++; return target.get(id); };
      const value: unknown = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const recordPort = new Proxy(repository, { get(target, key) {
      if (key === 'get') return async (...args: Parameters<KnowledgeRepository['get']>) => {
        counts.records++; const value = await target.get(...args); return transform ? transform(value) : value;
      };
      const value: unknown = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    return { counts, service: make(workPort, recordPort) };
  };
  return { states, repository, service, clock, edit, retain, promote, counted, make, setActor(value: TrustedKnowledgeActor) { current = value; } };
}

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`${backend}: a memory-only service rejects an unsupported retained input in a nested source work`, async t => {
    const f = await fixture(t, backend); const k = await f.service.create(input('K', 'X'));
    await f.retain('W', [k.dependency]); const m = await f.service.create(input('M', 'W'));
    assert.equal((await f.service.get('M')).card.id, 'M');
    await f.edit('X', state => { state.attempts.push({ ...attempt('succeeded'), id: 'nested-input', adopted: true,
      inputDependencies: [{ provider: 'board', workId: 'X', artifact: artifact() }] }); });
    await assert.rejects(f.service.get('M'), /knowledge_unavailable/);
    assert.equal(await f.service.validateDependencies([m.dependency]), false);
  });

  test(`${backend}: a memory tool cancels a blocked custody read before the source responds`, { timeout: 30000 }, async t => {
    const f = await fixture(t, backend); const k = await f.service.create(input('K', 'X'));
    await f.retain('W', [k.dependency]); await f.service.create(input('M', 'W'));
    const consumer = initial('consumer'); consumer.policy.allowedTools = ['core.memory.get'];
    await f.states.commit(command(consumer, 'consumer'));
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const repository = new Proxy(f.repository, { get(target, key) {
      if (key === 'get') return async (...args: Parameters<KnowledgeRepository['get']>) => {
        const value = await target.get(...args); if (args[1] === 'K') { entered(); await gate; } return value;
      };
      const value: unknown = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const { tools } = createKnowledgeTools({ states: f.states, repository, actors: { current: async () => actor() }, clock: f.clock, digester: new Sha256Digester() });
    const controller = new AbortController(), completed: { value?: ToolResult } = {};
    const running = tools.find(tool => tool.definition.id === 'core.memory.get')!.execute({ id: 'read', description: 'Read memory',
      toolId: 'core.memory.get', toolVersion: '1', effect: 'read', input: { id: 'M', maxBytes: 4096 }, maxAttempts: 1, dependsOn: [], satisfies: [] },
    { workId: consumer.id, attemptId: 'read-attempt', policy: consumer.policy, signal: controller.signal }).then(value => { completed.value = value; return value; });
    try {
      const waiting = await Promise.race([started.then(() => true), running.then(() => false)]); assert.equal(waiting, true);
      controller.abort(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(completed.value?.status, 'cancelled', 'the tool must finish before the blocked source is released');
    } finally { controller.abort(); release(); }
    const result = await running; assert.equal(result.status, 'cancelled'); assert.equal(result.output, null);
    assert.deepEqual(result.evidence, []); assert.deepEqual(result.artifacts, []); assert.equal(result.knowledgeDependencies, undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await f.states.get(consumer.id), consumer);
  });

  test(`${backend}: custody-free reads keep their original I/O path and a W to M to W custody cycle remains finite`, async t => {
    const f = await fixture(t, backend); const m = await f.service.create(input('M', 'W'));
    const ordinary = f.counted(); assert.equal((await ordinary.service.get('M')).card.body, input('M', 'W').body);
    assert.deepEqual(ordinary.counts, { works: 3, records: 3 }, 'three complete snapshots need no discarded pre-read or extra custody reads');
    await f.retain('W', [m.dependency]); const before = await f.states.get('W');
    const cyclic = f.counted(); assert.equal((await cyclic.service.get('M')).card.body, m.card.body);
    assert.ok(cyclic.counts.works <= 12 && cyclic.counts.records <= 12, 'custody cycles are visited once per bounded snapshot');
    assert.equal(await cyclic.service.validateDependencies([m.dependency]), true, 'unrelated work revision increments do not invalidate a semantic dependency');
    assert.deepEqual(await f.states.get('W'), before);
  });

  for (const change of ['revise', 'retract', 'expire', 'generation'] as const) {
    test(`${backend}: external K ${change} blocks direct, derived and cached M before W is refreshed`, async t => {
      const f = await fixture(t, backend); const k = await f.service.create(input('K', 'X', change === 'expire' ? 1500 : null));
      await f.retain('W', [k.dependency]); const m = await f.service.create(input('M', 'W'));
      await f.service.create({ ...input('D', 'W'), sources: [], derivedFrom: ['M'] });
      await f.service.syncIndex('team'); const query = { namespace: 'team', scope: 'fixture', text: 'Custody M' };
      assert.deepEqual((await f.service.search(query)).cards.map(card => card.id), ['M']);
      const work = await f.states.get('W');
      if (change === 'revise') await f.service.revise({ id: 'K', expectedRevision: 1, commandId: 'revise-K', reason: 'Original memory corrected', title: 'Corrected K', body: 'Corrected synthetic observation' });
      if (change === 'retract') await f.service.retract({ id: 'K', expectedRevision: 1, commandId: 'retract-K', reason: 'Original memory withdrawn' });
      if (change === 'expire') f.clock.advance(500);
      if (change === 'generation') await f.edit('X', state => { state.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] }; });
      await assert.rejects(f.service.get('M'), /knowledge_unavailable/);
      await assert.rejects(f.service.get('D'), /knowledge_unavailable/);
      await assert.rejects(f.service.create({ ...input('new-copy', 'W'), sources: [], derivedFrom: ['M'] }), /knowledge_unavailable/);
      assert.equal(await f.service.validateDependencies([m.dependency]), false);
      const cached = await f.service.search(query);
      assert.equal(cached.index.cached, change !== 'revise' && change !== 'retract', 'a changed index revision uses a fresh candidate cache key');
      assert.deepEqual(cached.cards, []);
      const repeated = await f.service.search(query); assert.equal(repeated.index.cached, true); assert.deepEqual(repeated.cards, []);
      assert.deepEqual(await f.states.get('W'), work, 'source work refresh is not needed to invalidate copied memory');
    });
  }

  test(`${backend}: a shared reader uses current M authority without impersonating its owner's private K actor`, async t => {
    const f = await fixture(t, backend); const k = await f.service.create(input('K', 'X'));
    await f.retain('W', [k.dependency]); await f.service.create(input('M', 'W')); await f.promote('M');
    f.setActor(actor('reader')); await assert.rejects(f.service.get('K'), /knowledge_unavailable/);
    const m = await f.service.get('M'); assert.equal(m.card.visibility, 'shared'); assert.equal(m.card.body, input('M', 'W').body);
    assert.equal(await f.service.validateDependencies([k.dependency]), false, 'external dependency validation still requires the exact current actor digest');
    assert.equal(await f.service.validateDependencies([m.dependency]), true);
    f.setActor({ ...actor('reader'), allowedLabels: [] }); await assert.rejects(f.service.get('M'), /knowledge_unavailable/);
    f.setActor(actor()); await f.service.retract({ id: 'K', expectedRevision: 1, commandId: 'retract-private-K', reason: 'Withdraw original private memory' });
    f.setActor(actor('reader')); await assert.rejects(f.service.get('M'), /knowledge_unavailable/);
  });

  test(`${backend}: custody does not reconstruct an unconfirmed reviewer-only permission`, async t => {
    const f = await fixture(t, backend); await f.service.create(input('K', 'X'));
    await f.service.submitForReview({ id: 'K', expectedRevision: 1, commandId: 'submit-K', reason: 'Pending review' });
    f.setActor({ ...actor('reviewer'), canReview: true }); const k = await f.service.get('K');
    await f.edit('W', state => { state.policy.principalId = 'reviewer'; }); await f.retain('W', [k.dependency]);
    await assert.rejects(f.service.create(input('M', 'W')), /knowledge_unavailable/);
    assert.equal(await f.repository.get('tenant-a', 'M'), null);
  });

  test(`${backend}: custody entry and byte limits fail closed before reading unbounded knowledge records`, async t => {
    const f = await fixture(t, backend); const k = await f.service.create(input('K', 'X')); await f.service.create(input('M', 'W'));
    await f.retain('W', Array.from({ length: 150 }, (_value, index) => ({ ...k.dependency, knowledgeId: `K-${index}` })));
    const counted = f.counted(); await assert.rejects(counted.service.get('M'), /knowledge_contention/);
    assert.deepEqual(counted.counts, { works: 1, records: 1 }, 'entry budget rejects the queue before dispatching excess record reads');
    await f.edit('W', state => { state.attempts = []; }); await f.retain('W', [k.dependency]);
    await f.edit('W', state => { state.evidence[0]!.facts['large'] = 'x'.repeat(4 * 1024 * 1024); });
    const oversized = f.counted(); await assert.rejects(oversized.service.get('M'), /knowledge_contention/);
    assert.deepEqual(oversized.counts, { works: 1, records: 1 });
  });

  test(`${backend}: a derivedFrom cycle remains invalid even when its work custody graph is finite`, async t => {
    const f = await fixture(t, backend); const k = await f.service.create(input('K', 'X')); await f.service.create(input('P', 'X'));
    await f.retain('W', [k.dependency]); await f.service.create(input('M', 'W'));
    const cyclic = f.counted(async record => record && ['K', 'P'].includes(record.id) ? { ...record, derivedFrom: [{ id: record.id === 'K' ? 'P' : 'K', revision: 1 }] } : record);
    await assert.rejects(cyclic.service.get('M'), /knowledge_unavailable/);
    assert.ok(cyclic.counts.records <= 4 && cyclic.counts.works <= 3);
  });

  test(`${backend}: external memory changed during closure collection cannot survive the stable snapshot`, async t => {
    const f = await fixture(t, backend); const k = await f.service.create(input('K', 'X'));
    await f.retain('W', [k.dependency]); await f.service.create(input('M', 'W')); let fired = false;
    const reading = f.counted(async record => {
      if (record?.id === 'K' && !fired) {
        fired = true; await f.service.retract({ id: 'K', expectedRevision: 1, commandId: 'retract-during-read', reason: 'Change after a captured K snapshot' });
      }
      return record;
    });
    await assert.rejects(reading.service.get('M'), /knowledge_unavailable|knowledge_contention/); assert.equal(fired, true);
    assert.ok(reading.counts.records < 40 && reading.counts.works < 40);
  });
}
