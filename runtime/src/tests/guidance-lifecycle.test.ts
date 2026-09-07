import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactRef, Json } from '../domain/model.js';
import type { ArtifactStore } from '../application/ports.js';
import { GuidanceCatalog, type GuidanceManifest, type GuidanceSource, type GuidanceSourcePage } from '../application/guidance.js';
import { validateScenario } from '../application/fixtures.js';
import { newWork } from '../application/new-work.js';
import { canonical, RandomIds, Sha256Digester, sha256 } from '../infrastructure/digest.js';
import { FakeClock } from '../infrastructure/fakes.js';
import { FileGuidanceSource } from '../infrastructure/file-guidance.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';

const body = 'Original guidance 본문'; const clock = () => new FakeClock(1000);
function manifest(id = 'core.guide', text = body): GuidanceManifest {
  return { id, version: '1', title: 'Guide', summary: 'Read source', source: `fixture://${id}`, tenantId: 'synthetic', labels: ['synthetic'],
    supportedKinds: ['lookup', 'compare', 'followup'], sha256: sha256(text), byteLength: new TextEncoder().encode(text).length, requiredRules: ['Preserve provenance'] };
}
function state() {
  const scenario = validateScenario(JSON.parse(readFileSync(new URL('../../fixtures/documents-simple.json', import.meta.url), 'utf8')));
  return newWork({ id: 'guidance-work', now: 1000, goal: scenario.goal, policy: scenario.policy,
    limits: { toolCalls: 10, modelCalls: 2, tokens: 10000, replans: 10, wallTimeMs: 100000 } });
}
const args = { id: 'core.guide', version: '1', kind: 'lookup' as const, reason: 'Read selected guidance', maxBytes: 65536 };
function gate<T>() {
  let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}
class Source implements GuidanceSource {
  manifests = [manifest()]; revision = 'source-1'; bodies = new Map<string, string>([['core.guide', body]]);
  reads = 0; validations = 0; lists = 0;
  listing: ((input: { cursor: string | null; signal: AbortSignal }) => Promise<GuidanceSourcePage>) | null = null;
  validating: (() => Promise<boolean>) | null = null;
  async list() { return structuredClone(this.manifests); }
  async listSnapshot(input: { cursor: string | null; signal: AbortSignal }) {
    this.lists++; if (this.listing) return this.listing(input); return { revision: this.revision, manifests: structuredClone(this.manifests), nextCursor: null };
  }
  async read(id: string) { this.reads++; const value = this.bodies.get(id); if (value === undefined) throw new Error('missing_source'); return new TextEncoder().encode(value); }
  async validate(value: GuidanceManifest) {
    this.validations++; if (this.validating) return this.validating();
    const latest = this.manifests.find(m => m.id === value.id && m.version === value.version); const bytes = this.bodies.get(value.id);
    return Boolean(latest && bytes !== undefined && canonical(latest as unknown as Json) === canonical(value as unknown as Json) && sha256(bytes) === value.sha256);
  }
}
class Artifacts extends MemoryArtifactStore {
  puts = 0; checks = 0; readable = true; onCheck: (() => Promise<void>) | null = null;
  override async put(bytes: Uint8Array, attrs: Parameters<ArtifactStore['put']>[1]) { this.puts++; return super.put(bytes, attrs); }
  override async exists(ref: ArtifactRef) { this.checks++; await this.onCheck?.(); return this.readable && super.exists(ref); }
}
async function setup(options: Parameters<typeof GuidanceCatalog.create>[1] = {}) {
  const source = new Source(); const artifacts = new Artifacts(); const catalogue = await GuidanceCatalog.create(source,
    { digester: new Sha256Digester(), clock: clock(), ids: new RandomIds(), ...options }); return { source, artifacts, catalogue, state: state() };
}

test('guidance refresh stages every provider page and only then replaces the complete snapshot', async () => {
  const h = await setup(); const started = gate<void>(); const finish = gate<GuidanceSourcePage>(); const initial = h.catalogue.list(h.state, 'lookup', 20);
  h.source.listing = async ({ cursor }) => { if (cursor === null) return { revision: 'next', manifests: [manifest('core.next')], nextCursor: 'last' };
    started.resolve(); return finish.promise; };
  const pending = h.catalogue.refresh(); await started.promise; assert.deepEqual(h.catalogue.list(h.state, 'lookup', 20), initial);
  finish.resolve({ revision: 'next', manifests: [manifest('core.last')], nextCursor: null }); const result = await pending;
  assert.equal(result.pages, 2); assert.equal(result.entryCount, 2); assert.equal(result.sourceRevision, 'next');
  assert.deepEqual(h.catalogue.list(h.state, 'lookup', 20).cards.map(c => c.id), ['core.last', 'core.next']);
});

for (const reason of ['failure', 'mixed', 'duplicate', 'cycle', 'page-bound', 'entry-bound', 'byte-bound'] as const) test(`guidance ${reason} listing leaves the previous snapshot usable`, async () => {
  const h = await setup(); const revision = h.catalogue.revision; let pages = 0;
  h.source.listing = async () => {
    pages++;
    if (reason === 'failure' && pages === 2) throw new Error('provider_failed');
    return { revision: reason === 'mixed' && pages === 2 ? 'wrong' : 'next', manifests: reason === 'entry-bound' && pages === 2 ? [manifest('core.last')] : reason === 'duplicate' || pages === 1 ? [manifest('core.next')] : [],
      nextCursor: pages === 1 || reason === 'cycle' ? 'tail' : null };
  };
  await assert.rejects(h.catalogue.refresh({ ...(reason === 'page-bound' ? { maxPages: 1 } : {}), ...(reason === 'entry-bound' ? { maxEntries: 1 } : {}), ...(reason === 'byte-bound' ? { maxBytes: 1 } : {}) }));
  assert.equal(h.catalogue.revision, revision); assert.equal(h.catalogue.describe(h.state, 'core.guide', '1').sha256, sha256(body));
  if (reason === 'page-bound' || reason === 'byte-bound') assert.equal(pages, 1);
});

test('guidance abort and late completion cannot replace a published listing', async () => {
  const h = await setup(); const started = gate<void>(); const finish = gate<GuidanceSourcePage>(); const control = new AbortController();
  h.source.listing = async () => { started.resolve(); return finish.promise; }; const pending = h.catalogue.refresh({ signal: control.signal });
  await started.promise; control.abort(); await assert.rejects(pending, /guidance_cancelled/);
  finish.resolve({ revision: 'late', manifests: [], nextCursor: null }); await finish.promise; await Promise.resolve();
  assert.equal(h.catalogue.revision, 1); assert.equal(h.catalogue.list(h.state, 'lookup', 20).cards.length, 1);
});

test('guidance concurrent refresh rejects an earlier listing and a complete empty snapshot retires entries', async () => {
  const h = await setup(); const started = gate<void>(); const finish = gate<GuidanceSourcePage>();
  h.source.listing = async () => { started.resolve(); return finish.promise; }; const old = h.catalogue.refresh(); await started.promise;
  h.source.listing = async () => ({ revision: 'newest', manifests: [], nextCursor: null }); await h.catalogue.refresh();
  finish.resolve({ revision: 'older', manifests: [manifest('core.older')], nextCursor: null }); await assert.rejects(old, /guidance_snapshot_conflict/);
  assert.deepEqual(h.catalogue.list(h.state, 'lookup', 20), { cards: [], hasMore: false });
});

test('legacy list/load remains compatible and missing source validation disables body reuse', async () => {
  const source = new Source(); const artifacts = new Artifacts(); const catalog = await GuidanceCatalog.create({ list: source.list.bind(source), read: source.read.bind(source) });
  assert.equal(catalog.sourceRevision, null);
  await catalog.load(state(), artifacts, args); await catalog.load(state(), artifacts, args);
  assert.equal(source.reads, 2); assert.equal(artifacts.puts, 2); assert.equal(catalog.metrics().bodyDecodes, 2); assert.equal(catalog.metrics().cachedBodies, 0);
  assert.deepEqual(Object.keys(catalog.list(state(), 'lookup', 20)).sort(), ['cards', 'hasMore']);
});

test('guidance pages reach beyond 20 and preserve item and whole UTF-8 page bounds', async () => {
  const h = await setup(); h.source.manifests = Array.from({ length: 43 }, (_, n) => ({ ...manifest(`core.guide_${String(n).padStart(2, '0')}`), summary: '한'.repeat(200) }));
  await h.catalogue.refresh(); const ids: string[] = []; let cursor: string | null = null;
  do {
    const result = h.catalogue.listPage(h.state, { kind: 'lookup', limit: 20, maxBytes: 3000, cursor });
    assert.equal(result.byteLength, new TextEncoder().encode(JSON.stringify(result)).length); assert.ok(result.byteLength <= 3000); assert.ok(result.cards.length > 0 && result.cards.length <= 20);
    ids.push(...result.cards.map(card => card.id)); cursor = result.nextCursor;
  } while (cursor !== null);
  assert.equal(new Set(ids).size, 43); assert.deepEqual(ids, h.source.manifests.map(m => m.id));
  const small = h.catalogue.listPage(h.state, { kind: 'lookup', limit: 20, maxBytes: 256 });
  assert.equal(small.status, 'too_large'); assert.equal(small.nextCursor, null); assert.deepEqual(small.cards, []); assert.ok(small.requiredBytes! > 256);
});

test('guidance cursor binds kind, owner, permission and snapshot and hides unauthorized counts', async () => {
  const h = await setup(); h.source.manifests = Array.from({ length: 25 }, (_, n) => manifest(`core.guide_${n}`)); await h.catalogue.refresh();
  const first = h.catalogue.listPage(h.state, { kind: 'lookup', limit: 20, maxBytes: 65536 }); assert.ok(first.nextCursor);
  for (const change of ['kind', 'owner', 'labels'] as const) {
    const current = structuredClone(h.state); if (change === 'owner') current.policy.principalId = 'different'; if (change === 'labels') current.policy.allowedLabels = [];
    assert.throws(() => h.catalogue.listPage(current, { kind: change === 'kind' ? 'compare' : 'lookup', limit: 20, maxBytes: 65536, cursor: first.nextCursor }), /catalog_cursor_mismatch/);
  }
  await h.catalogue.refresh(); assert.throws(() => h.catalogue.listPage(h.state, { kind: 'lookup', limit: 20, maxBytes: 65536, cursor: first.nextCursor }), /catalog_cursor_stale/);
  const restricted = { ...h.state, policy: { ...h.state.policy, allowedLabels: [] } };
  const empty = h.catalogue.listPage(restricted, { kind: 'lookup', limit: 20, maxBytes: 256 }); assert.deepEqual(empty.cards, []); assert.equal(empty.hasMore, false);
});

test('hot guidance reuses only body/artifact while rules, selection reason and method are current', async () => {
  const h = await setup(); const cold = await h.catalogue.load(h.state, h.artifacts, args); assert.equal(cold.status, 'available');
  h.source.manifests[0]!.requiredRules = ['New required rule']; h.source.revision = 'source-2'; await h.catalogue.refresh();
  const later = structuredClone(h.state); later.goal.revision++; const hot = await h.catalogue.load(later, h.artifacts, { ...args, kind: 'compare', reason: 'Compare current sources' });
  assert.equal(hot.status, 'available'); if (cold.status !== 'available' || hot.status !== 'available') return;
  assert.equal(hot.body, cold.body); assert.deepEqual(hot.artifact, cold.artifact); assert.deepEqual(hot.manifest.requiredRules, ['New required rule']);
  assert.equal(hot.selectedFor.goalRevision, later.goal.revision); assert.equal(hot.selectedFor.reason, 'Compare current sources');
  assert.equal(cold.method.id, 'core.direct-lookup'); assert.equal(hot.method.id, 'core.evidence-comparison');
  assert.equal(hot.role, 'guidance_only'); assert.equal(hot.grantsPermissions, false);
  assert.equal(h.source.reads, 1); assert.equal(h.source.validations, 2); assert.equal(h.artifacts.puts, 1); assert.equal(h.artifacts.checks, 1);
  assert.deepEqual(h.catalogue.metrics(), { sourceReadCalls: 1, sourceReadBytes: new TextEncoder().encode(body).length, sourceValidateCalls: 2,
    artifactPutCalls: 1, artifactCheckCalls: 1, bodyDecodes: 1, cacheHits: 1, cacheMisses: 1, cachedBodies: 1, cachedBytes: new TextEncoder().encode(body).length });
  hot.manifest.requiredRules![0] = 'Caller mutation'; assert.deepEqual(h.catalogue.describe(h.state, args.id, args.version).requiredRules, ['New required rule']);
});

test('guidance body cache cannot bypass current tenant, label or work-kind restrictions', async () => {
  const h = await setup(); await h.catalogue.load(h.state, h.artifacts, args);
  for (const policy of [{ ...h.state.policy, tenantId: 'foreign' }, { ...h.state.policy, allowedLabels: [] }]) await assert.rejects(h.catalogue.load({ ...h.state, policy }, h.artifacts, args), /guidance_unavailable/);
  h.source.manifests[0]!.supportedKinds = ['compare']; await h.catalogue.refresh();
  await assert.rejects(h.catalogue.load(h.state, h.artifacts, args), /guidance_unavailable/); assert.equal(h.source.reads, 1); assert.equal(h.source.validations, 1);
});

test('guidance cache obeys entry/byte bounds, evicts unused bodies and isolates artifact stores', async () => {
  const h = await setup({ maxCachedBodies: 1, maxCachedBytes: 100 });
  h.source.manifests.push(manifest('core.second', 'other body')); h.source.bodies.set('core.second', 'other body'); await h.catalogue.refresh();
  await h.catalogue.load(h.state, h.artifacts, args); await h.catalogue.load(h.state, h.artifacts, { ...args, id: 'core.second' });
  assert.equal(h.catalogue.metrics().cachedBodies, 1); await h.catalogue.load(h.state, h.artifacts, args); assert.equal(h.source.reads, 3);
  const separate = new Artifacts(); await h.catalogue.load(h.state, separate, args); assert.equal(separate.puts, 1); assert.equal(h.source.reads, 4);
  h.source.manifests = []; await h.catalogue.refresh(); assert.equal(h.catalogue.metrics().cachedBodies, 0); assert.equal(h.catalogue.metrics().cachedBytes, 0);
});

test('a body larger than the cache byte budget is read and decoded on every load', async () => {
  const h = await setup({ maxCachedBytes: 1 }); await h.catalogue.load(h.state, h.artifacts, args); await h.catalogue.load(h.state, h.artifacts, args);
  assert.equal(h.catalogue.metrics().cachedBodies, 0); assert.equal(h.catalogue.metrics().cachedBytes, 0);
  assert.equal(h.source.reads, 2); assert.equal(h.artifacts.puts, 2); assert.equal(h.catalogue.metrics().bodyDecodes, 2);
});

test('a pending hot load cannot exceed cache bounds when another body evicts its old entry', async () => {
  const h = await setup({ maxCachedBodies: 1 }); h.source.manifests.push(manifest('core.second', 'second body')); h.source.bodies.set('core.second', 'second body');
  await h.catalogue.refresh(); await h.catalogue.load(h.state, h.artifacts, args);
  const started = gate<void>(); const finish = gate<void>(); h.artifacts.onCheck = async () => { h.artifacts.onCheck = null; started.resolve(); await finish.promise; };
  const hot = h.catalogue.load(h.state, h.artifacts, args); await started.promise;
  await h.catalogue.load(h.state, h.artifacts, { ...args, id: 'core.second' }); finish.resolve(); await hot;
  assert.equal(h.catalogue.metrics().cachedBodies, 1); assert.equal(h.catalogue.metrics().cachedBytes, new TextEncoder().encode(body).length);
});

test('a cold legacy-source load rechecks its manifest after artifact persistence', async () => {
  const source = new Source(); const catalogue = await GuidanceCatalog.create({ list: source.list.bind(source), read: source.read.bind(source) });
  const backing = new Artifacts(); const artifacts: ArtifactStore = { get: backing.get.bind(backing), exists: backing.exists.bind(backing),
    async put(bytes, attributes) { const ref = await backing.put(bytes, attributes); source.manifests[0]!.requiredRules = ['Changed during put']; await catalogue.refresh(); return ref; } };
  await assert.rejects(catalogue.load(state(), artifacts, args), /guidance_(source_)?changed/); assert.equal(catalogue.metrics().cachedBodies, 0);
});

test('source changes during an artifact check are caught by the final probe', async () => {
  const h = await setup(); await h.catalogue.load(h.state, h.artifacts, args);
  h.artifacts.onCheck = async () => { h.source.bodies.delete('core.guide'); };
  await assert.rejects(h.catalogue.load(h.state, h.artifacts, args), /guidance_source_changed/); assert.equal(h.catalogue.metrics().cacheHits, 0);
});

test('manifest refresh during final validation rejects a hot result from the previous rules', async () => {
  const h = await setup(); await h.catalogue.load(h.state, h.artifacts, args); const started = gate<void>(); const finish = gate<boolean>();
  h.source.validating = async () => { started.resolve(); return finish.promise; };
  const pending = h.catalogue.load(h.state, h.artifacts, args); await started.promise;
  h.source.manifests[0]!.requiredRules = ['Replaced while waiting']; await h.catalogue.refresh(); finish.resolve(true);
  await assert.rejects(pending, /guidance_changed/); assert.equal(h.catalogue.metrics().cacheHits, 0);
});

test('load cancellation cannot publish a cache entry after an ignored-signal provider returns', async () => {
  const h = await setup(); const started = gate<void>(); const finish = gate<boolean>(); const control = new AbortController();
  h.source.validating = async () => { started.resolve(); return finish.promise; };
  const pending = h.catalogue.load(h.state, h.artifacts, args, { signal: control.signal }); await started.promise; control.abort();
  await assert.rejects(pending, /guidance_cancelled/); finish.resolve(true); await finish.promise; await Promise.resolve();
  assert.equal(h.catalogue.metrics().cachedBodies, 0);
});

async function pack(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'guidance-lifecycle-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const write = async (m = manifest(), text = body) => { await writeFile(join(directory, 'guide.md'), text); await writeFile(join(directory, 'catalog.json'), JSON.stringify({ schemaVersion: 1, entries: [{ ...m, bodyFile: 'guide.md' }] })); };
  await write(); const source = new FileGuidanceSource(directory); const catalogue = await GuidanceCatalog.create(source); const artifacts = new Artifacts();
  return { directory, source, catalogue, artifacts, write };
}

test('file guidance reports actual cold/hot original I/O separately from put/decode reuse', async t => {
  const h = await pack(t); const initial = h.source.metrics(); await h.catalogue.load(state(), h.artifacts, args); const cold = h.source.metrics();
  await h.catalogue.load(state(), h.artifacts, args); const hot = h.source.metrics(); const bytes = new TextEncoder().encode(body).length;
  assert.equal(cold.bodyReads - initial.bodyReads, 2); assert.equal(cold.bodyBytes - initial.bodyBytes, bytes * 2);
  assert.equal(hot.bodyReads - cold.bodyReads, 1); assert.equal(hot.bodyBytes - cold.bodyBytes, bytes);
  assert.equal(cold.catalogReads - initial.catalogReads, 4); assert.equal(hot.catalogReads - cold.catalogReads, 2);
  assert.equal(hot.readCalls, 1); assert.equal(hot.validateCalls, 2); assert.equal(h.artifacts.puts, 1); assert.equal(h.artifacts.checks, 1); assert.equal(h.catalogue.metrics().bodyDecodes, 1);
  t.diagnostic(JSON.stringify({ coldOriginalReads: cold.bodyReads - initial.bodyReads, hotOriginalReads: hot.bodyReads - cold.bodyReads,
    coldOriginalBytes: cold.bodyBytes - initial.bodyBytes, hotOriginalBytes: hot.bodyBytes - cold.bodyBytes,
    source: hot, catalog: h.catalogue.metrics(), artifactPuts: h.artifacts.puts, artifactChecks: h.artifacts.checks }));
});

for (const change of ['deleted', 'modified', 'manifest'] as const) test(`file guidance cache never bypasses a ${change} original source`, async t => {
  const h = await pack(t); await h.catalogue.load(state(), h.artifacts, args);
  if (change === 'deleted') await unlink(join(h.directory, 'guide.md'));
  if (change === 'modified') await writeFile(join(h.directory, 'guide.md'), 'corrupted original');
  if (change === 'manifest') await h.write({ ...manifest(), requiredRules: ['Unrefreshed new rule'] });
  await assert.rejects(h.catalogue.load(state(), h.artifacts, args), /guidance_source_changed/); assert.equal(h.catalogue.metrics().cacheHits, 0);
});

test('file guidance refresh observes a new catalog, preserves same-body cache and rejects invalid replacements', async t => {
  const h = await pack(t); await h.catalogue.load(state(), h.artifacts, args); const originalRevision = h.catalogue.sourceRevision;
  await h.write({ ...manifest(), requiredRules: ['Current filesystem rule'] }); await h.catalogue.refresh(); assert.notEqual(h.catalogue.sourceRevision, originalRevision);
  const loaded = await h.catalogue.load(state(), h.artifacts, args); assert.equal(loaded.status, 'available');
  if (loaded.status === 'available') assert.deepEqual(loaded.manifest.requiredRules, ['Current filesystem rule']); assert.equal(h.artifacts.puts, 1);
  const current = h.catalogue.revision; await writeFile(join(h.directory, 'catalog.json'), '{'); await assert.rejects(h.catalogue.refresh()); assert.equal(h.catalogue.revision, current);
});
