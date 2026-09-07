import test from 'node:test';
import assert from 'node:assert/strict';
import type { Policy, TaskSpec } from '../domain/model.js';
import type { Tool, ToolDefinition } from '../application/ports.js';
import { snapshotTool, ToolContracts } from '../application/tool-contracts.js';
import { ToolCatalog, type CatalogSearchPage } from '../application/tool-catalog.js';
import { refreshProviderTools, type ProviderToolPage, type ProviderToolSource, type ProviderRefreshOptions } from '../application/provider-tool-snapshot.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { FakeClock } from '../infrastructure/fakes.js';

function tool(id: string, patch: Partial<ToolDefinition> = {}): Tool {
  return { definition: { provider: id.split('.')[0]!, id, version: '1', description: `Document 문서 lookup ${id}`,
    effect: 'read', inputSchema: { type: 'object', additionalProperties: false, properties: {} }, outputSchema: { type: 'object' },
    destination: 'local', labels: ['public'], ...patch }, execute: async () => { throw new Error('listing_must_not_execute'); } };
}
function policy(tools: Tool[]): Policy {
  return { tenantId: 'tenant-a', principalId: 'owner-a', allowedTools: tools.map(t => t.definition.id), allowedDestinations: ['local'], allowedLabels: ['public'], allowWrites: false };
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
function page(tools: Tool[], nextCursor: string | null = null, revision = 'provider-v2'): ProviderToolPage { return { revision, tools, nextCursor }; }
function scripted(pages: Array<ProviderToolPage | Error>): ProviderToolSource & { calls: Array<string | null> } {
  const calls: Array<string | null> = [];
  return { calls, list: async ({ cursor }) => { const next = pages[calls.length]; calls.push(cursor); if (!next) throw new Error('unexpected_list'); if (next instanceof Error) throw next; return next; } };
}
function baseline() {
  const old = tool('alpha.old'); const other = tool('beta.keep'); const contracts = new ToolContracts([old, other], new AjvSchemas());
  return { old, other, contracts, before: contracts.revision, epoch: contracts.providerEpoch('alpha') };
}
function unchanged(h: ReturnType<typeof baseline>) {
  assert.equal(h.contracts.revision, h.before); assert.equal(h.contracts.providerEpoch('alpha'), h.epoch);
  assert.ok(h.contracts.get('alpha.old', '1')); assert.ok(h.contracts.get('beta.keep', '1')); assert.equal(h.contracts.get('alpha.new', '1'), undefined);
}
const signal = () => new AbortController().signal;
const encoded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

test('provider pages become visible in one publication and keep unrelated providers', async () => {
  const h = baseline(); const entered = deferred<void>(); const finish = deferred<ProviderToolPage>(); const cursors: Array<string | null> = [];
  const refreshing = refreshProviderTools(h.contracts, 'alpha', { list: async ({ cursor }) => {
    cursors.push(cursor); if (cursor === null) return page([tool('alpha.new')], 'second'); entered.resolve(); return finish.promise;
  } }, { signal: signal() });
  await entered.promise; unchanged(h); finish.resolve(page([tool('alpha.last')]));
  const result = await refreshing;
  assert.deepEqual(cursors, [null, 'second']); assert.equal(result.pages, 2); assert.equal(result.toolCount, 2);
  assert.equal(result.byteLength, encoded({ revision: 'provider-v2', tools: [tool('alpha.new').definition], nextCursor: 'second' }) +
    encoded({ revision: 'provider-v2', tools: [tool('alpha.last').definition], nextCursor: null }));
  assert.equal(h.contracts.revision, h.before + 1); assert.equal(h.contracts.providerEpoch('alpha'), h.epoch + 1);
  assert.equal(h.contracts.get('alpha.old', '1'), undefined); assert.ok(h.contracts.get('alpha.new', '1')); assert.ok(h.contracts.get('alpha.last', '1'));
  assert.ok(h.contracts.get('beta.keep', '1'));
});

test('only a complete empty provider listing retires that provider', async () => {
  const h = baseline(); const entered = deferred<void>(); const finish = deferred<ProviderToolPage>();
  const pending = refreshProviderTools(h.contracts, 'alpha', { list: async ({ cursor }) => {
    if (cursor === null) return page([], 'tail'); entered.resolve(); return finish.promise;
  } }, { signal: signal() });
  await entered.promise; unchanged(h); finish.resolve(page([])); await pending;
  assert.equal(h.contracts.get('alpha.old', '1'), undefined); assert.ok(h.contracts.get('beta.keep', '1'));
  assert.deepEqual(h.contracts.providerSnapshot('alpha'), { epoch: 2, sourceRevision: 'provider-v2', toolCount: 0 });
});

const failures: Array<{ name: string; pages: Array<ProviderToolPage | Error>; error: RegExp; options?: Partial<Omit<ProviderRefreshOptions, 'signal'>> }> = [
  { name: 'partial transport failure', pages: [page([tool('alpha.new')], 'tail'), new Error('private source error body')], error: /^Error: provider_listing_failed$/ },
  { name: 'mixed provider revisions', pages: [page([tool('alpha.new')], 'tail'), page([], null, 'changed')], error: /provider_revision_mixed/ },
  { name: 'cross-page duplicate', pages: [page([tool('alpha.new')], 'tail'), page([tool('alpha.new')])], error: /duplicate_or_invalid_tool/ },
  { name: 'pagination cycle', pages: [page([tool('alpha.new')], 'tail'), page([], 'tail')], error: /provider_cursor_cycle/ },
  { name: 'wrong provider namespace', pages: [page([tool('beta.new')])], error: /provider_namespace_mismatch/ },
  { name: 'invalid namespace definition', pages: [page([tool('alpha.new', { provider: 'beta' })])], error: /invalid_contract/ },
  { name: 'invalid JSON schema', pages: [page([tool('alpha.new', { inputSchema: { type: 'imaginary' } })])], error: /invalid_tool_schema/ },
  { name: 'invalid availability', pages: [page([{ ...tool('alpha.new'), availability: 'offline' } as unknown as Tool])], error: /invalid_tool_adapter/ },
  { name: 'missing completeness cursor', pages: [{ revision: 'v2', tools: [] } as unknown as ProviderToolPage], error: /invalid_provider_page/ },
  { name: 'undeclared partial flag', pages: [{ ...page([]), partial: true } as unknown as ProviderToolPage], error: /invalid_provider_page/ },
  { name: 'page bound', pages: [page([tool('alpha.new')], 'tail'), page([])], options: { maxPages: 1 }, error: /provider_page_limit/ },
  { name: 'tool bound', pages: [page([tool('alpha.new'), tool('alpha.extra')])], options: { maxTools: 1 }, error: /provider_tool_limit/ },
  { name: 'definition byte bound', pages: [page([tool('alpha.new')])], options: { maxBytes: 32 }, error: /provider_byte_limit/ },
];
for (const failure of failures) test(`provider ${failure.name} preserves the previously published snapshot`, async () => {
  const h = baseline(); const source = scripted(failure.pages);
  await assert.rejects(refreshProviderTools(h.contracts, 'alpha', source, { signal: signal(), ...failure.options }), failure.error);
  unchanged(h); assert.equal(source.calls.length, failure.name === 'page bound' ? 1 : failure.pages.length);
});

test('provider pre-cancellation makes no listing call', async () => {
  const h = baseline(); const control = new AbortController(); control.abort(); const source = scripted([page([])]);
  await assert.rejects(refreshProviderTools(h.contracts, 'alpha', source, { signal: control.signal }), /provider_refresh_cancelled/);
  assert.equal(source.calls.length, 0); unchanged(h);
});

test('provider abort ends an ignored-signal wait and late listing cannot publish', async () => {
  const h = baseline(); const entered = deferred<void>(); const late = deferred<ProviderToolPage>(); const control = new AbortController(); let receivedSignal: AbortSignal | undefined;
  const refreshing = refreshProviderTools(h.contracts, 'alpha', { list: async ({ signal }) => { receivedSignal = signal; entered.resolve(); return late.promise; } }, { signal: control.signal });
  await entered.promise; control.abort(); await assert.rejects(refreshing, /provider_refresh_cancelled/);
  assert.equal(receivedSignal?.aborted, true); unchanged(h); late.resolve(page([tool('alpha.new')])); await late.promise; await Promise.resolve(); unchanged(h);
});

test('provider abort during schema compilation still prevents publication', async () => {
  const control = new AbortController(); const schemas = new AjvSchemas(); let shouldAbort = false;
  const contracts = new ToolContracts([tool('alpha.old')], { compile: schema => { if (shouldAbort) control.abort(); return schemas.compile(schema); } });
  shouldAbort = true;
  await assert.rejects(refreshProviderTools(contracts, 'alpha', scripted([page([tool('alpha.new')])]), { signal: control.signal }), /provider_refresh_cancelled/);
  assert.equal(contracts.revision, 1); assert.ok(contracts.get('alpha.old', '1')); assert.equal(contracts.get('alpha.new', '1'), undefined);
});

test('concurrent same-provider refresh refuses an older listing after a newer publication', async () => {
  const h = baseline(); const started = deferred<void>(); const older = deferred<ProviderToolPage>();
  const a = refreshProviderTools(h.contracts, 'alpha', { list: async () => { started.resolve(); return older.promise; } }, { signal: signal() });
  await started.promise; await refreshProviderTools(h.contracts, 'alpha', scripted([page([tool('alpha.new')], null, 'newer')]), { signal: signal() });
  older.resolve(page([tool('alpha.late')], null, 'older')); await assert.rejects(a, /provider_snapshot_conflict/);
  assert.ok(h.contracts.get('alpha.new', '1')); assert.equal(h.contracts.get('alpha.late', '1'), undefined); assert.equal(h.contracts.revision, h.before + 1);
});

test('concurrent unrelated provider refreshes both publish without reverting each other', async () => {
  const h = baseline(); const started = deferred<void>(); const older = deferred<ProviderToolPage>();
  const a = refreshProviderTools(h.contracts, 'alpha', { list: async () => { started.resolve(); return older.promise; } }, { signal: signal() });
  await started.promise; await refreshProviderTools(h.contracts, 'beta', scripted([page([tool('beta.new')])]), { signal: signal() });
  older.resolve(page([tool('alpha.new')])); await a;
  assert.ok(h.contracts.get('alpha.new', '1')); assert.ok(h.contracts.get('beta.new', '1')); assert.equal(h.contracts.revision, h.before + 2);
});

test('provider staging snapshots metadata and callbacks before awaiting another page', async () => {
  const h = baseline(); const candidate = tool('alpha.new'); const started = deferred<void>(); const finish = deferred<ProviderToolPage>(); let originalCalls = 0; let replacementCalls = 0;
  Object.assign(candidate, { availability: 'available' });
  candidate.execute = async () => { originalCalls++; throw new Error('original_callback'); };
  const pending = refreshProviderTools(h.contracts, 'alpha', { list: async ({ cursor }) => {
    if (cursor === null) return page([candidate], 'tail'); started.resolve(); return finish.promise;
  } }, { signal: signal() });
  await started.promise; candidate.definition.description = 'mutated'; candidate.definition.labels.push('restricted');
  Object.assign(candidate, { availability: 'stored_only' });
  candidate.execute = async () => { replacementCalls++; throw new Error('replacement_callback'); }; finish.resolve(page([])); await pending;
  const stored = h.contracts.get('alpha.new', '1')!;
  assert.equal(stored.tool.availability, 'available'); assert.ok(Object.isFrozen(stored.tool));
  assert.notEqual(stored.tool.definition.description, 'mutated'); assert.deepEqual(stored.tool.definition.labels, ['public']);
  assert.equal(originalCalls, 0); assert.equal(replacementCalls, 0);
  const task: TaskSpec = { id: 'probe', description: 'callback identity', toolId: 'alpha.new', toolVersion: '1', input: {}, dependsOn: [], effect: 'read', maxAttempts: 1, satisfies: [] };
  await assert.rejects(stored.tool.execute(task, { workId: 'w', attemptId: 'a', policy: policy([candidate]), signal: signal() }), /original_callback/);
  assert.equal(originalCalls, 1); assert.equal(replacementCalls, 0); assert.throws(() => { stored.tool.definition.labels.push('changed'); }, TypeError);
  const snapshot = h.contracts.providerSnapshot('alpha')!; snapshot.epoch = 99; assert.equal(h.contracts.providerEpoch('alpha'), 2);
});

test('availability is optional captured host metadata, with contract and permission errors preserved', () => {
  const legacy = tool('alpha.read'); const access = policy([legacy]);
  const task: TaskSpec = { id: 'read', description: 'Read a document', toolId: legacy.definition.id, toolVersion: '1',
    input: {}, dependsOn: [], effect: 'read', maxAttempts: 1, satisfies: [] };
  let reads = 0;
  const candidate: Tool = { ...legacy, get availability() { reads++; return 'stored_only' as const; } };
  const captured = snapshotTool(candidate); assert.equal(reads, 1);
  assert.equal(captured.availability, 'stored_only'); assert.ok(Object.isFrozen(captured));
  assert.equal(Object.hasOwn(snapshotTool(legacy), 'availability'), false);
  assert.deepEqual(captured.definition, snapshotTool(legacy).definition);
  const contracts = new ToolContracts([captured], new AjvSchemas());
  assert.equal(contracts.check(task, access), null);
  assert.equal(contracts.checkExecution(task, access), 'tool_connection_required');
  assert.equal(contracts.checkExecution(task, { ...access, allowedTools: [] }), 'tool_permission_denied');
  assert.equal(contracts.checkExecution({ ...task, input: { extra: true } }, access), 'invalid_tool_input');
  assert.equal(contracts.checkExecution({ ...task, toolVersion: 'missing' }, access), 'tool_version_unavailable');
  const normal = new ToolContracts([legacy], new AjvSchemas());
  assert.equal(normal.checkExecution(task, access), null); assert.deepEqual(normal.callable(access), normal.visible(access));
  for (const availability of [null, false, {}, 'offline'])
    assert.throws(() => snapshotTool({ ...legacy, availability } as unknown as Tool), /invalid_tool_adapter/);
});

test('stored-only provider publication changes callable discovery and cursors without changing proof contracts', async () => {
  const h = catalogFixture(3), before = h.contracts.visible(h.policy);
  const digest = h.digester.digest(JSON.parse(JSON.stringify(before)));
  const initial = h.catalog.searchPage(h.policy, { query: 'document', limit: 1, maxBytes: 65536 }); assert.ok(initial.nextCursor);
  const unavailable = h.tools[0]!;
  await refreshProviderTools(h.contracts, 'alpha', scripted([page(h.tools.map((value, index) =>
    index === 0 ? { ...value, availability: 'stored_only' as const } : value), null, 'stored-only')]), { signal: signal() });
  assert.deepEqual(h.contracts.visible(h.policy), before);
  assert.equal(h.digester.digest(JSON.parse(JSON.stringify(h.contracts.visible(h.policy)))), digest);
  assert.deepEqual(h.contracts.get(unavailable.definition.id, '1')!.tool.definition, unavailable.definition);
  assert.deepEqual(h.catalog.search(h.policy, { query: 'document', limit: 20 }).cards.map(value => value.id), h.tools.slice(1).map(value => value.definition.id));
  const current = first(h); assert.equal(current.cards.length, 2); assert.equal(current.hasMore, false);
  assert.throws(() => h.catalog.describe(h.policy, { id: unavailable.definition.id, version: '1' }, 65536), /^Error: tool_connection_required$/);
  assert.throws(() => h.catalog.describe({ ...h.policy, allowedTools: [] }, { id: unavailable.definition.id, version: '1' }, 65536), /^Error: tool_unavailable$/);
  assert.throws(() => h.catalog.searchPage(h.policy, { query: 'document', limit: 1, maxBytes: 65536, cursor: initial.nextCursor }), /catalog_cursor_stale/);
  await refreshProviderTools(h.contracts, 'alpha', scripted([page(h.tools, null, 'connected')]), { signal: signal() });
  const restored = h.catalog.describe(h.policy, { id: unavailable.definition.id, version: '1' }, 65536);
  assert.equal(restored.status, 'available'); assert.deepEqual(h.contracts.callable(h.policy), before);
  assert.equal(restored.card.contractDigest, initial.cards[0]!.contractDigest);
});

function catalogFixture(count = 47, options: ConstructorParameters<typeof ToolCatalog>[2] = {}) {
  const tools = Array.from({ length: count }, (_, n) => tool(`alpha.document_${String(n).padStart(3, '0')}`));
  const contracts = new ToolContracts(tools, new AjvSchemas()); const digester = new Sha256Digester();
  return { tools, contracts, digester, catalog: new ToolCatalog(contracts, digester, options), policy: policy(tools) };
}
function first(h: ReturnType<typeof catalogFixture>, maxBytes = 65536) { return h.catalog.searchPage(h.policy, { query: 'document', limit: 20, maxBytes }); }

test('catalog cursor pages reach every permitted result after 20 without duplicate or missing cards', () => {
  const h = catalogFixture(); const collected: string[] = []; let cursor: string | null = null; const sizes: number[] = [];
  do {
    const page: CatalogSearchPage = h.catalog.searchPage(h.policy, { query: 'document', limit: 20, maxBytes: 65536, cursor });
    assert.equal(page.status, 'available'); assert.equal(page.byteLength, encoded(page)); assert.ok(page.byteLength <= 65536);
    collected.push(...page.cards.map(c => c.id)); sizes.push(page.cards.length); cursor = page.nextCursor;
    assert.equal(page.hasMore, cursor !== null);
  } while (cursor);
  assert.deepEqual(sizes, [20, 20, 7]); assert.deepEqual(collected, h.tools.map(t => t.definition.id)); assert.equal(new Set(collected).size, 47);
  assert.deepEqual(Object.keys(h.catalog.search(h.policy, { query: 'document', limit: 20 })).sort(), ['cards', 'hasMore']);
});

test('catalog cursor replay returns the same cards while allowing a smaller per-page item limit', () => {
  const h = catalogFixture(); const initial = first(h); const input = { query: 'document', limit: 10, maxBytes: 65536, cursor: initial.nextCursor };
  const a = h.catalog.searchPage(h.policy, input); const b = h.catalog.searchPage(h.policy, input);
  assert.deepEqual(a.cards, b.cards); assert.equal(a.cards[0]!.id, 'alpha.document_020'); assert.equal(a.cards.length, 10);
  a.cards[0]!.description = 'caller mutation'; assert.notEqual(h.catalog.searchPage(h.policy, input).cards[0]!.description, 'caller mutation');
});

for (const binding of ['query', 'tenant', 'principal', 'tools', 'labels', 'destinations', 'writes'] as const) test(`catalog cursor is bound to current ${binding}`, () => {
  const h = catalogFixture(); const initial = first(h); const changed = structuredClone(h.policy); let query = 'document';
  if (binding === 'query') query = 'lookup';
  if (binding === 'tenant') changed.tenantId = 'tenant-b';
  if (binding === 'principal') changed.principalId = 'owner-b';
  if (binding === 'tools') changed.allowedTools.pop();
  if (binding === 'labels') changed.allowedLabels = [];
  if (binding === 'destinations') changed.allowedDestinations = [];
  if (binding === 'writes') changed.allowWrites = true;
  assert.throws(() => h.catalog.searchPage(changed, { query, limit: 20, maxBytes: 65536, cursor: initial.nextCursor }), /catalog_cursor_mismatch/);
  assert.equal(h.catalog.searchPage(h.policy, { query: 'document', limit: 20, maxBytes: 65536, cursor: initial.nextCursor }).cards[0]!.id, 'alpha.document_020');
});

test('catalog cursor rejects unpublished, stale, and restarted lookup state', () => {
  const h = catalogFixture(); const initial = first(h);
  assert.throws(() => h.catalog.searchPage(h.policy, { query: 'document', limit: 20, maxBytes: 65536, cursor: `${initial.nextCursor}tamper` }), /catalog_cursor_stale/);
  assert.throws(() => new ToolCatalog(h.contracts, h.digester).searchPage(h.policy, { query: 'document', limit: 20, maxBytes: 65536, cursor: initial.nextCursor }), /catalog_cursor_stale/);
  h.contracts.replaceProvider('alpha', h.tools, { expectedEpoch: 1, sourceRevision: 'identical-definition-new-snapshot' });
  assert.throws(() => h.catalog.searchPage(h.policy, { query: 'document', limit: 20, maxBytes: 65536, cursor: initial.nextCursor }), /catalog_cursor_stale/);
  assert.equal(first(h).snapshotRevision, initial.snapshotRevision + 1);
});

test('catalog cursor expires by injected clock and bounded index eviction requires a fresh search', () => {
  const clock = new FakeClock(1000); const h = catalogFixture(47, { clock, ids: new RandomIds(), cursorTtlMs: 50, maxCursors: 1 });
  const expired = first(h); clock.advance(50);
  assert.throws(() => h.catalog.searchPage(h.policy, { query: 'document', limit: 20, maxBytes: 65536, cursor: expired.nextCursor }), /catalog_cursor_stale/);
  const evicted = first(h); const live = first(h);
  assert.throws(() => h.catalog.searchPage(h.policy, { query: 'document', limit: 20, maxBytes: 65536, cursor: evicted.nextCursor }), /catalog_cursor_stale/);
  assert.equal(h.catalog.searchPage(h.policy, { query: 'document', limit: 20, maxBytes: 65536, cursor: live.nextCursor }).cards.length, 20);
});

test('catalog applies permissions before rank, total page size, and hasMore', () => {
  const visible = tool('alpha.visible'); const hidden = Array.from({ length: 40 }, (_, i) => tool(`alpha.hidden_${i}`, { description: 'PRIVATE_MARKER document', labels: ['restricted'] }));
  const all = [visible, ...hidden]; const contracts = new ToolContracts(all, new AjvSchemas()); const catalog = new ToolCatalog(contracts, new Sha256Digester());
  const access = policy(all); const result = catalog.searchPage(access, { query: 'document', limit: 20, maxBytes: 65536 });
  assert.deepEqual(result.cards.map(c => c.id), ['alpha.visible']); assert.equal(result.hasMore, false); assert.equal(result.nextCursor, null);
  assert.equal(JSON.stringify(result).includes('PRIVATE_MARKER'), false);
  const visibleOnly = new ToolCatalog(new ToolContracts([visible], new AjvSchemas()), new Sha256Digester()).searchPage(access, { query: 'document', limit: 20, maxBytes: 65536 });
  assert.deepEqual(result, visibleOnly);
});

test('catalog page budgets count Unicode and the entire response envelope', () => {
  const tools = Array.from({ length: 12 }, (_, i) => tool(`alpha.unicode_${i}`, { description: `문서 ${'한'.repeat(237)}` }));
  const catalog = new ToolCatalog(new ToolContracts(tools, new AjvSchemas()), new Sha256Digester()); const access = policy(tools); const query = '문서'.normalize('NFD');
  const result = catalog.searchPage(access, { query, limit: 20, maxBytes: 3000 });
  assert.equal(result.status, 'available'); assert.ok(result.cards.length > 0 && result.cards.length < tools.length);
  assert.equal(result.byteLength, encoded(result)); assert.ok(result.byteLength <= 3000); assert.ok(result.nextCursor);
  const small = catalog.searchPage(access, { query, limit: 20, maxBytes: 256 });
  assert.equal(small.status, 'too_large'); assert.deepEqual(small.cards, []); assert.equal(small.nextCursor, null);
  assert.ok(small.requiredBytes! > 256); assert.equal(small.byteLength, encoded(small)); assert.ok(small.byteLength <= 256);
  const exact = catalog.searchPage(access, { query, limit: 1, maxBytes: small.requiredBytes! });
  assert.equal(exact.status, 'available'); assert.equal(exact.cards.length, 1); assert.equal(exact.byteLength, small.requiredBytes);
});

test('catalog rejects invalid bounds and keeps punctuation-only search bounded and empty', () => {
  const h = catalogFixture();
  for (const input of [{ query: 'document', limit: 21, maxBytes: 65536 }, { query: 'document', limit: 20, maxBytes: 65537 },
    { query: 'document', limit: 20, maxBytes: 255 }, { query: 'document', limit: 20, maxBytes: Number.NaN }]) assert.throws(() => h.catalog.searchPage(h.policy, input), /invalid_contract/);
  const empty = h.catalog.searchPage(h.policy, { query: '!!!', limit: 20, maxBytes: 256 });
  assert.deepEqual(empty.cards, []); assert.equal(empty.hasMore, false); assert.equal(empty.nextCursor, null); assert.equal(empty.byteLength, encoded(empty));
  assert.throws(() => new ToolCatalog(h.contracts, h.digester, { cursorTtlMs: 10 }), /invalid_catalog_cursor_options/);
});

test('catalog reuses immutable definition digests across cursor pages and refreshes after registry replacement', () => {
  const h = catalogFixture(); let definitionsHashed = 0; const digester = new Sha256Digester();
  const catalog = new ToolCatalog(h.contracts, { digest: value => {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'inputSchema' in value) definitionsHashed++;
    return digester.digest(value);
  } });
  const first = catalog.searchPage(h.policy, { query: 'document', limit: 20, maxBytes: 65536 }); assert.equal(definitionsHashed, 47);
  const next = catalog.searchPage(h.policy, { query: 'document', limit: 20, maxBytes: 65536, cursor: first.nextCursor });
  assert.equal(next.cards.length, 20); assert.equal(definitionsHashed, 47);
  h.contracts.replaceProvider('alpha', h.tools.map(t => ({ ...t, definition: { ...t.definition, description: `${t.definition.description} current` } })),
    { expectedEpoch: 1, sourceRevision: 'v3' });
  const current = catalog.searchPage(h.policy, { query: 'document', limit: 20, maxBytes: 65536 });
  assert.equal(definitionsHashed, 94); assert.notEqual(current.cards[0]!.contractDigest, first.cards[0]!.contractDigest);
});
