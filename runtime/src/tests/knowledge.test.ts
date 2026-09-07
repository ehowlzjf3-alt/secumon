import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeService } from '../application/knowledge-service.js';
import { KnowledgeDependencySchema } from '../application/knowledge-contracts.js';
import type { KnowledgeRepository } from '../application/knowledge-ports.js';
import type { StateRepository } from '../application/ports.js';
import type { TrustedKnowledgeActor } from '../domain/knowledge.js';
import type { Evidence, WorkState } from '../domain/model.js';
import { SqliteKnowledgeRepository } from '../infrastructure/sqlite-knowledge.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { FakeClock } from '../infrastructure/fakes.js';
import { initial, advance, command, openRepository } from './state-conformance-helpers.js';
import type { Adapter } from './state-conformance-helpers.js';

function evidence(id = 'e1'): Evidence {
  return { id, tenantId: 'tenant-a', scope: 'fixture', sourceId: 'source-document', lineageId: 'source-document', locator: 'fixture://synthetic-source',
    observedAt: 1000, recordedAt: 1001, labels: ['synthetic'], coverage: 'complete', status: 'accepted', access: 'available',
    supersedes: [], derivedFrom: [], facts: { available: true }, artifact: null };
}
function actor(principalId = 'person-a'): TrustedKnowledgeActor {
  return { tenantId: 'tenant-a', principalId, allowedLabels: ['synthetic'], allowedNamespaces: ['team'], allowedScopes: ['fixture'], canReview: false, canPublish: true };
}
const input = (id = 'note') => ({ id, commandId: `create-${id}`, namespace: 'team', scope: 'fixture', kind: 'experience' as const,
  title: '관측 기억 Retention', body: '관측 결과: 보존 기간은 30일. REVIEWED evidence candidate.', labels: [] as string[],
  sources: [{ workId: 'work-1', evidenceId: 'e1' }], expiresAt: null });

async function harness(t: TestContext, adapter: Adapter = 'sqlite') {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-contract-'));
  const states = openRepository(adapter, directory); const repository = new SqliteKnowledgeRepository(join(directory, 'knowledge.sqlite'));
  const access = { actor: actor() }; const clock = new FakeClock(1100); const digester = new Sha256Digester();
  const actors = { current: async () => structuredClone(access.actor) };
  const state = initial(); state.evidence = [evidence()]; assert.equal((await states.commit(command(state, 'seed'))).kind, 'committed');
  let mutation = 0;
  const mutate = async (change: (state: WorkState) => void) => {
    const next = advance((await states.get('work-1'))!); change(next);
    assert.equal((await states.commit(command(next, `change-${++mutation}`))).kind, 'committed');
  };
  const make = (statePort: StateRepository = states, knowledgePort: KnowledgeRepository = repository) => new KnowledgeService({ states: statePort, repository: knowledgePort, actors, clock, digester });
  t.after(async () => { await states.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, states, repository, access, actors, clock, digester, mutate, make, service: make() };
}

for (const adapter of ['sqlite', 'file-journal'] as const) {
  test(`knowledge exact lookup precedes index, Korean/English and conditional search use current sources (${adapter})`, async t => {
    const h = await harness(t, adapter); const read = await h.service.create(input());
    assert.equal(read.card.body, input().body); assert.equal(read.card.coverage, 'complete');
    assert.equal(await h.service.validateDependencies([read.dependency]), true);
    const before = await h.service.search({ namespace: 'team', scope: 'fixture', text: '보존 기간' });
    assert.deepEqual(before.cards, []); assert.equal(before.index.status, 'lagging'); assert.equal(before.index.complete, false);
    await h.service.syncIndex('team');
    for (const text of ['보존 기간', 'retention', 'REVIEWED', '관측'.normalize('NFD')]) {
      const found = await h.service.search({ namespace: 'team', scope: 'fixture', text });
      assert.equal(found.cards[0]?.id, 'note'); assert.equal(found.index.status, 'ready');
    }
    assert.equal((await h.service.search({ namespace: 'team', scope: 'fixture', kinds: ['fact'] })).cards.length, 0);
    assert.equal((await h.service.search({ namespace: 'team', scope: 'fixture', observedFrom: 1001 })).cards.length, 0);
    assert.equal((await h.service.search({ namespace: 'team', scope: 'fixture', observedFrom: 999, observedThrough: 1001 })).cards.length, 1);
    await assert.rejects(h.service.create({ ...input('forged'), principalId: 'person-b' } as never));
    await assert.rejects(h.service.search({ namespace: 'team', scope: 'fixture', limit: 51 }));
  });
}

test('private memory needs explicit submission and another reviewer of the exact content revision', async t => {
  const h = await harness(t); await h.service.create(input());
  h.access.actor = { ...actor('reviewer'), canReview: true };
  await assert.rejects(h.service.get('note'), /knowledge_unavailable/);
  await assert.rejects(h.service.reviewAndPromote({ id: 'note', expectedRevision: 1, expectedContentRevision: 1, commandId: 'premature', reason: 'review' }), /knowledge_unavailable|knowledge_review/);
  h.access.actor = actor();
  await h.service.submitForReview({ id: 'note', expectedRevision: 1, commandId: 'submit', reason: 'request explicit review' });
  await assert.rejects(h.service.reviewAndPromote({ id: 'note', expectedRevision: 2, expectedContentRevision: 1, commandId: 'self', reason: 'self review' }), /knowledge_unavailable/);
  h.access.actor = { ...actor('reviewer'), canReview: true };
  assert.equal((await h.service.get('note')).card.reviewState, 'submitted');
  await assert.rejects(h.service.reviewAndPromote({ id: 'note', expectedRevision: 2, expectedContentRevision: 2, commandId: 'wrong-version', reason: 'review' }), /knowledge_review_revision_conflict/);
  await h.service.reviewAndPromote({ id: 'note', expectedRevision: 2, expectedContentRevision: 1, commandId: 'promote', reason: 'source and scope verified' });
  h.access.actor = actor('reader');
  const shared = await h.service.get('note'); assert.equal(shared.card.visibility, 'shared');
  assert.equal(shared.card.review?.reviewerId, 'reviewer');
  assert.doesNotMatch(JSON.stringify(shared.card), /fixture:\/\/|work-1|"evidenceId"|"facts"/);
  await assert.rejects(h.service.create(input('foreign-source')), /knowledge_unavailable/);
  await h.service.create({ ...input('derived-shared'), sources: [], derivedFrom: ['note'] });
  assert.equal((await h.repository.get('tenant-a', 'derived-shared'))!.sources.length, 1);
  h.access.actor.allowedScopes = []; await assert.rejects(h.service.get('note'), /knowledge_unavailable/);
  h.access.actor = { ...actor('reader'), allowedNamespaces: ['other'] }; await assert.rejects(h.service.get('note'), /knowledge_unavailable/);
  h.access.actor = { ...actor('reader'), tenantId: 'tenant-b' }; await assert.rejects(h.service.get('note'), /knowledge_unavailable/);
});

for (const change of ['retracted', 'restricted', 'deleted', 'corrected', 'policy', 'generation'] as const) {
  test(`source ${change} prevents direct, cached lexical and dependency reuse`, async t => {
    const h = await harness(t); const read = await h.service.create(input()); await h.service.syncIndex('team');
    const query = { namespace: 'team', scope: 'fixture', text: '보존' };
    assert.equal((await h.service.search(query)).cards.length, 1);
    await h.mutate(s => {
      if (change === 'retracted') s.evidence[0]!.status = 'retracted';
      if (change === 'restricted' || change === 'deleted') s.evidence[0]!.access = change;
      if (change === 'corrected') s.evidence.push({ ...evidence('e2'), observedAt: 1001, recordedAt: 1002, supersedes: ['e1'], facts: { available: false } });
      if (change === 'policy') s.policy.allowedLabels = [];
      if (change === 'generation') s.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] };
    });
    await assert.rejects(h.service.get('note'), /knowledge_unavailable/);
    assert.equal(await h.service.validateDependencies([read.dependency]), false);
    const found = await h.service.search(query); assert.equal(found.index.cached, true); assert.deepEqual(found.cards, []);
    await h.service.rebuildIndex('team'); assert.deepEqual((await h.service.search(query)).cards, []);
  });
}

test('ancestor changes and derived memories retain source identity without inflating independent provenance', async t => {
  const h = await harness(t);
  await h.mutate(s => { s.evidence.push({ ...evidence('summary'), sourceId: 'summary', derivedFrom: ['e1'] }); });
  await h.service.create({ ...input('from-summary'), sources: [{ workId: 'work-1', evidenceId: 'summary' }] });
  await h.service.create(input('parent'));
  const child = await h.service.create({ ...input('child'), derivedFrom: ['parent'], sources: [{ workId: 'work-1', evidenceId: 'e1' }] });
  assert.equal(child.card.sourceVersions.length, 1); assert.equal((await h.repository.get('tenant-a', 'child'))!.sources.length, 1);
  await h.service.revise({ id: 'parent', expectedRevision: 1, commandId: 'correct-parent', reason: 'correct a remembered detail', title: 'Corrected note', body: 'Updated observation wording' });
  await assert.rejects(h.service.get('child'), /knowledge_unavailable/);
  await h.mutate(s => { s.evidence[0]!.access = 'restricted'; });
  await assert.rejects(h.service.get('from-summary'), /knowledge_unavailable/);
  await assert.rejects(h.service.create({ ...input('stale-child'), sources: [], derivedFrom: ['parent'] }), /knowledge_unavailable/);
});

test('review CAS prevents a reviewed draft from being silently replaced or shared after editing', async t => {
  const h = await harness(t); await h.service.create(input());
  await h.service.submitForReview({ id: 'note', expectedRevision: 1, commandId: 'submit', reason: 'review draft' });
  await h.service.revise({ id: 'note', expectedRevision: 2, commandId: 'revise', reason: 'new content', title: 'Updated draft', body: 'Different text' });
  h.access.actor = { ...actor('reviewer'), canReview: true };
  await assert.rejects(h.service.reviewAndPromote({ id: 'note', expectedRevision: 2, expectedContentRevision: 1, commandId: 'late-review', reason: 'old draft' }), /knowledge_revision_conflict/);
  await assert.rejects(h.service.get('note'), /knowledge_unavailable/);
  assert.equal((await h.repository.get('tenant-a', 'note'))!.visibility, 'private');
});

test('source or actor changes while source reads wait cannot return stale memory content', async t => {
  const h = await harness(t); await h.service.create(input());
  for (const race of ['actor', 'source'] as const) {
    let release!: () => void; let started!: () => void; let first = true;
    const paused = new Promise<void>(resolve => { started = resolve; }); const resumed = new Promise<void>(resolve => { release = resolve; });
    const states = new Proxy(h.states, { get(target, key) {
      if (key === 'get') return async (id: string) => { const value = await target.get(id); if (first) { first = false; started(); await resumed; } return value; };
      const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const service = h.make(states); const pending = service.get('note'); await paused;
    if (race === 'actor') h.access.actor.allowedLabels = [];
    else await h.mutate(s => { s.evidence[0]!.access = 'restricted'; });
    release(); await assert.rejects(pending, /knowledge_unavailable/); h.access.actor = actor();
  }
});

test('a delayed candidate cache fill rechecks namespace authority before returning cards or counts', async t => {
  const h = await harness(t); await h.service.create(input()); await h.service.syncIndex('team');
  let release!: () => void; let started!: () => void;
  const paused = new Promise<void>(resolve => { started = resolve; }); const resumed = new Promise<void>(resolve => { release = resolve; });
  const repository = new Proxy(h.repository, { get(target, key) {
    if (key === 'candidates') return async (...args: Parameters<KnowledgeRepository['candidates']>) => { const result = await target.candidates(...args); started(); await resumed; return result; };
    const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const pending = h.make(h.states, repository).search({ namespace: 'team', scope: 'fixture' }); await paused;
  h.access.actor.allowedNamespaces = []; release(); await assert.rejects(pending, /knowledge_unavailable/);
});

test('index errors remain distinct from absence and rebuild never resurrects deleted or expired content', async t => {
  const h = await harness(t); await h.service.create(input()); await h.service.syncIndex('team');
  await h.repository.markIndexError('tenant-a', 'team', 'index_read_failed');
  const failed = await h.service.search({ namespace: 'team', scope: 'fixture', text: 'missing' });
  assert.equal(failed.index.status, 'error'); assert.equal(failed.index.complete, false); assert.equal((await h.service.get('note')).card.id, 'note');
  await h.service.rebuildIndex('team'); assert.equal((await h.repository.indexHead('tenant-a', 'team')).error, null);
  await h.service.create({ ...input('expiry'), expiresAt: 1200 }); await h.service.syncIndex('team'); h.clock.advance(100);
  await assert.rejects(h.service.get('expiry'), /knowledge_unavailable/);
  await h.service.delete({ id: 'note', expectedRevision: 1, commandId: 'delete', reason: 'remove content' });
  assert.equal((await h.repository.get('tenant-a', 'note'))!.body, '');
  assert.equal((await h.service.search({ namespace: 'team', scope: 'fixture' })).cards.length, 0);
  await h.service.rebuildIndex('team'); assert.equal((await h.service.search({ namespace: 'team', scope: 'fixture' })).cards.length, 0);
});

test('SQLite reopen retains memory, review, cursor and receipts; competing writers use revision CAS', async t => {
  const h = await harness(t); const first = await h.service.create(input());
  const second = new SqliteKnowledgeRepository(join(h.directory, 'knowledge.sqlite')); t.after(() => second.close());
  const reopened = h.make(h.states, second);
  assert.equal((await reopened.get('note')).card.body, first.card.body);
  assert.equal((await reopened.search({ namespace: 'team', scope: 'fixture' })).index.status, 'lagging');
  const duplicate = await reopened.create(input()); assert.equal(duplicate.card.revision, 1);
  await assert.rejects(reopened.create({ ...input(), body: 'different reuse of same command' }), /knowledge_command_conflict/);
  const mutations = await Promise.allSettled([
    h.service.revise({ id: 'note', expectedRevision: 1, commandId: 'writer-a', reason: 'edit', title: 'Writer A', body: 'a' }),
    reopened.revise({ id: 'note', expectedRevision: 1, commandId: 'writer-b', reason: 'edit', title: 'Writer B', body: 'b' }),
  ]);
  assert.equal(mutations.filter(m => m.status === 'fulfilled').length, 1);
  assert.equal(mutations.filter(m => m.status === 'rejected').length, 1);
  await reopened.rebuildIndex('team');
  const third = new SqliteKnowledgeRepository(join(h.directory, 'knowledge.sqlite')); t.after(() => third.close());
  assert.deepEqual(await third.indexHead('tenant-a', 'team'), await second.indexHead('tenant-a', 'team'));
  assert.equal((await h.make(h.states, third).get('note')).card.revision, 2);
});

test('source and knowledge stores close and reopen with reviewed memory and index intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-restart-'));
  let states = openRepository('sqlite', directory); let repository = new SqliteKnowledgeRepository(join(directory, 'knowledge.sqlite'));
  const clock = new FakeClock(1100); const digester = new Sha256Digester(); let current = actor();
  const actors = { current: async () => structuredClone(current) };
  try {
    const state = initial(); state.evidence = [evidence()]; await states.commit(command(state, 'seed'));
    let service = new KnowledgeService({ states, repository, clock, digester, actors });
    await service.create(input()); await service.submitForReview({ id: 'note', expectedRevision: 1, commandId: 'submit', reason: 'review' });
    current = { ...actor('reviewer'), canReview: true };
    await service.reviewAndPromote({ id: 'note', expectedRevision: 2, expectedContentRevision: 1, commandId: 'promote', reason: 'verified source' });
    await service.syncIndex('team'); const head = await repository.indexHead('tenant-a', 'team');
    await states.close(); await repository.close();
    states = openRepository('sqlite', directory); repository = new SqliteKnowledgeRepository(join(directory, 'knowledge.sqlite'));
    current = actor('reader'); service = new KnowledgeService({ states, repository, clock, digester, actors });
    const search = await service.search({ namespace: 'team', scope: 'fixture', text: '보존' });
    assert.equal(search.cards[0]?.review?.reviewerId, 'reviewer'); assert.equal(search.cards[0]?.visibility, 'shared');
    assert.deepEqual(await repository.indexHead('tenant-a', 'team'), head);
    assert.equal(await service.validateDependencies(search.dependencies), true);
  } finally { await states.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('bounded results report truncation only after current visibility filtering', async t => {
  const h = await harness(t); await h.service.create(input('a')); await h.service.create(input('b')); await h.service.syncIndex('team');
  const found = await h.service.search({ namespace: 'team', scope: 'fixture', limit: 1 });
  assert.equal(found.cards.length, 1); assert.equal(found.index.complete, false);
  h.access.actor = actor('other');
  const hidden = await h.service.search({ namespace: 'team', scope: 'fixture', limit: 1 });
  assert.equal(hidden.cards.length, 0); assert.equal(hidden.index.complete, true);
});

test('deletion while a repeated source check waits is noticed before returning the memory card', async t => {
  const h = await harness(t); await h.service.create(input());
  let release!: () => void; let started!: () => void; let reads = 0;
  const paused = new Promise<void>(resolve => { started = resolve; }); const resumed = new Promise<void>(resolve => { release = resolve; });
  const states = new Proxy(h.states, { get(target, key) {
    if (key === 'get') return async (id: string) => { const state = await target.get(id); if (++reads === 2) { started(); await resumed; } return state; };
    const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const pending = h.make(states).get('note'); await paused;
  await h.service.delete({ id: 'note', expectedRevision: 1, commandId: 'delete-during-read', reason: 'remove draft' });
  release(); await assert.rejects(pending, /knowledge_unavailable/);
});

test('source deletion after the second source snapshot cannot return its old card', async t => {
  const h = await harness(t); await h.service.create(input());
  let reads = 0; let deleted = false;
  const states = new Proxy(h.states, { get(target, key) {
    if (key === 'get') return async (id: string) => {
      const snapshot = await target.get(id);
      if (++reads === 2) {
        await h.mutate(s => { s.evidence[0]!.access = 'deleted'; s.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] }; });
        deleted = true;
      }
      return snapshot;
    };
    const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  await assert.rejects(h.make(states).get('note'), /knowledge_unavailable|knowledge_contention/);
  assert.equal(deleted, true); assert.ok(reads >= 3);
});

test('batch dependency fences notice an earlier card source changing while a later card is checked', async t => {
  const h = await harness(t); await h.mutate(s => { s.evidence.push({ ...evidence('e2'), sourceId: 'independent', lineageId: 'independent' }); });
  await h.service.create(input('a'));
  await h.service.create({ ...input('b'), sources: [{ workId: 'work-1', evidenceId: 'e2' }] });
  await h.service.syncIndex('team'); let readsB = 0; let changed = false;
  const repository = new Proxy(h.repository, { get(target, key) {
    if (key === 'get') return async (tenantId: string, id: string) => {
      if (id === 'b' && ++readsB === 4) {
        await h.mutate(s => { s.evidence[0]!.access = 'deleted'; s.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] }; }); changed = true;
      }
      return target.get(tenantId, id);
    };
    const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const service = h.make(h.states, repository); const search = await service.search({ namespace: 'team', scope: 'fixture' });
  assert.equal(changed, true); assert.equal(search.cards.some(c => c.id === 'a'), false);
  assert.equal(await service.validateDependencies(search.dependencies), true);
});

test('retracted memory can subsequently be deleted while preserving the revision and idempotency rules', async t => {
  const h = await harness(t); await h.service.create(input()); await h.service.syncIndex('team');
  await h.service.retract({ id: 'note', expectedRevision: 1, commandId: 'retract-first', reason: 'withdraw inaccurate note' });
  const deletion = { id: 'note', expectedRevision: 2, commandId: 'delete-after-retract', reason: 'remove retained content' };
  assert.deepEqual(await h.service.delete(deletion), { id: 'note', revision: 3 });
  assert.deepEqual(await h.service.delete(deletion), { id: 'note', revision: 3 });
  const record = (await h.repository.get('tenant-a', 'note'))!;
  assert.equal(record.status, 'deleted'); assert.equal(record.body, ''); assert.equal(record.title, '[deleted]');
  await assert.rejects(h.service.get('note'), /knowledge_unavailable/);
  await h.service.rebuildIndex('team'); assert.equal((await h.service.search({ namespace: 'team', scope: 'fixture' })).cards.length, 0);
});

test('a pruned limited search stays partial when an unread matching candidate remains', async t => {
  const h = await harness(t);
  for (const id of ['a', 'b', 'c']) await h.service.create(input(id));
  await h.service.syncIndex('team'); let heads = 0; let deleted = false;
  const repository = new Proxy(h.repository, { get(target, key) {
    if (key === 'indexHead') return async (...args: Parameters<KnowledgeRepository['indexHead']>) => {
      const snapshot = await target.indexHead(...args);
      if (++heads === 2) { await h.service.delete({ id: 'a', expectedRevision: 1, commandId: 'delete-a', reason: 'remove during final search validation' }); deleted = true; }
      return snapshot;
    };
    const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const service = h.make(h.states, repository); const found = await service.search({ namespace: 'team', scope: 'fixture', limit: 1 });
  assert.equal(deleted, true); assert.deepEqual(found.cards.map(c => c.id), ['b']);
  assert.equal(found.index.complete, false); assert.equal((await service.get('c')).card.id, 'c');
  assert.equal(found.index.revision, (await h.repository.indexHead('tenant-a', 'team')).revision);
});

test('unrelated work revisions preserve semantic dependencies while changed source content does not', async t => {
  const h = await harness(t); const read = await h.service.create(input());
  await h.mutate(s => { s.statusReason = 'recorded a separate receive event'; });
  assert.equal(await h.service.validateDependencies([read.dependency]), true);
  const current = await h.service.get('note');
  assert.notEqual(current.dependency.sources[0]!.workRevision, read.dependency.sources[0]!.workRevision);
  assert.equal(current.dependency.sources[0]!.sourceVersion, read.dependency.sources[0]!.sourceVersion);
  await h.mutate(s => { s.evidence[0]!.facts = { available: false }; });
  assert.equal(await h.service.validateDependencies([read.dependency]), false);
});

test('dependency contracts reject forged fields, unsafe revisions, malformed hashes and duplicate references', async t => {
  const h = await harness(t); const { dependency } = await h.service.create(input());
  assert.deepEqual(KnowledgeDependencySchema.parse(dependency), dependency);
  const source = dependency.sources[0]!;
  const invalid = [
    { ...dependency, content: 'extra field' },
    { ...dependency, actorDigest: 'short' },
    { ...dependency, knowledgeRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...dependency, sources: [{ ...source, workRevision: 0 }] },
    { ...dependency, sources: [{ ...source, generation: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...dependency, sources: [{ ...source, policyDigest: 'g'.repeat(64) }] },
    { ...dependency, sources: [{ ...source, sourceVersion: 'BAD' }] },
    { ...dependency, sources: [{ ...source, unrelated: true }] },
    { ...dependency, sources: [source, source] },
    { ...dependency, parents: [{ id: dependency.knowledgeId, revision: 1 }] },
    { ...dependency, parents: [{ id: 'p', revision: 1 }, { id: 'p', revision: 1 }] },
  ];
  for (const candidate of invalid) {
    assert.equal(KnowledgeDependencySchema.safeParse(candidate).success, false);
    assert.equal(await h.service.validateDependencies([candidate as typeof dependency]), false);
  }
});

test('continuously changing coherent-read revisions stop after a bounded number of fences', async t => {
  const h = await harness(t); await h.service.create(input()); let reads = 0;
  const states = new Proxy(h.states, { get(target, key) {
    if (key === 'get') return async (id: string) => {
      const snapshot = await target.get(id); reads++;
      await h.mutate(s => { s.statusReason = `concurrent event ${reads}`; }); return snapshot;
    };
    const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  await assert.rejects(h.make(states).get('note'), /knowledge_contention/);
  assert.ok(reads <= 6, `bounded read attempts: ${reads}`);
});
