import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKnowledgeTools, KNOWLEDGE_TOOL_IDS } from '../application/knowledge-tools.js';
import { KnowledgeService } from '../application/knowledge-service.js';
import type { KnowledgeRepository, TrustedKnowledgeActorProvider } from '../application/knowledge-ports.js';
import type { StateRepository } from '../application/ports.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { ToolResultSchema } from '../application/contracts.js';
import type { Evidence, Policy, TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import type { TrustedKnowledgeActor } from '../domain/knowledge.js';
import { SqliteKnowledgeRepository } from '../infrastructure/sqlite-knowledge.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { FakeClock } from '../infrastructure/fakes.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { initial, advance, command, openRepository } from './state-conformance-helpers.js';
import type { Adapter } from './state-conformance-helpers.js';

function actor(): TrustedKnowledgeActor {
  return { tenantId: 'tenant-a', principalId: 'person-a', allowedLabels: ['synthetic'], allowedNamespaces: ['team'], allowedScopes: ['fixture', 'elsewhere'], canReview: false, canPublish: true };
}
function source(): Evidence {
  return { id: 'source-evidence', tenantId: 'tenant-a', scope: 'fixture', sourceId: 'source-record', lineageId: 'source-record', locator: 'fixture://source',
    observedAt: 1000, recordedAt: 1001, labels: ['synthetic'], coverage: 'complete', status: 'accepted', supersedes: [], derivedFrom: [], facts: { available: true }, artifact: null };
}
const note = (id = 'note') => ({ id, commandId: `create-${id}`, namespace: 'team', scope: 'fixture', kind: 'experience' as const,
  title: '검토 기억 Retention', body: '관측 결과: 보존 기간 30일.', labels: [] as string[], sources: [{ workId: 'work-1', evidenceId: 'source-evidence' }], expiresAt: null });
async function harness(t: TestContext, adapter: Adapter = 'sqlite') {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-tools-'));
  const states = openRepository(adapter, directory); const repository = new SqliteKnowledgeRepository(join(directory, 'knowledge.sqlite'));
  const access = { actor: actor() }; const actors = { current: async () => structuredClone(access.actor) };
  const clock = new FakeClock(1100); const digester = new Sha256Digester();
  const original = initial(); original.evidence = [source()]; await states.commit(command(original, 'source'));
  const consumer = initial('consumer'); consumer.policy.allowedTools = [...KNOWLEDGE_TOOL_IDS]; await states.commit(command(consumer, 'consumer'));
  const policy = structuredClone(consumer.policy);
  let revision = 0;
  const mutate = async (workId: string, edit: (state: WorkState) => void) => {
    const state = advance((await states.get(workId))!); edit(state);
    assert.equal((await states.commit(command(state, `mutation-${++revision}`))).kind, 'committed');
  };
  const service = new KnowledgeService({ states, repository, actors, clock, digester });
  await service.create(note());
  const make = (ports: { states?: StateRepository; repository?: KnowledgeRepository; actors?: TrustedKnowledgeActorProvider } = {}) =>
    createKnowledgeTools({ states, repository, actors, clock, digester, ...ports });
  const wrapper = make(); let attempt = 0;
  const invoke = async (toolId: typeof KNOWLEDGE_TOOL_IDS[number], input: TaskSpec['input'], options: {
    wrapper?: ReturnType<typeof make>; policy?: Policy; signal?: AbortSignal; workId?: string;
  } = {}) => {
    const tool = (options.wrapper ?? wrapper).tools.find(t => t.definition.id === toolId)!;
    const task: TaskSpec = { id: `task-${++attempt}`, description: 'Read a synthetic memory', toolId, toolVersion: '1', effect: 'read', input, maxAttempts: 1, dependsOn: [], satisfies: [] };
    return tool.execute(task, { workId: options.workId ?? 'consumer', attemptId: `attempt-${attempt}`, policy: options.policy ?? policy, signal: options.signal ?? new AbortController().signal });
  };
  t.after(async () => { await states.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); });
  return { states, repository, actors, access, clock, digester, service, policy, mutate, make, wrapper, invoke };
}
function publicOutput(result: ToolResult): Record<string, unknown> {
  assert.ok(result.output && typeof result.output === 'object' && !Array.isArray(result.output));
  return result.output;
}
function delayGet(repository: KnowledgeRepository) {
  let release!: () => void; let started!: () => void; let first = true;
  const paused = new Promise<void>(resolve => { started = resolve; }); const resumed = new Promise<void>(resolve => { release = resolve; });
  const port = new Proxy(repository, { get(target, key) {
    if (key === 'get') return async (...args: Parameters<KnowledgeRepository['get']>) => {
      const value = await target.get(...args); if (first) { first = false; started(); await resumed; } return value;
    };
    const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { port, paused, release: () => release() };
}

for (const adapter of ['sqlite', 'file-journal'] as const) {
  test(`memory tools expose read cards, internal dependencies and schema-valid results (${adapter})`, async t => {
    const h = await harness(t, adapter); const contracts = new ToolContracts(h.wrapper.tools, new AjvSchemas());
    assert.deepEqual(h.wrapper.tools.map(t => t.definition.id), [...KNOWLEDGE_TOOL_IDS]);
    assert.ok(h.wrapper.tools.every(t => t.definition.effect === 'read' && t.definition.destination === 'local'));
    assert.equal(contracts.get('core.memory.get', '1')!.input({ id: 'note', maxBytes: 4096 }), true);
    assert.equal(contracts.get('core.memory.get', '1')!.input({ id: 'note', maxBytes: 4096, principalId: 'person-b' }), false);
    const result = await h.invoke('core.memory.get', { id: 'note', maxBytes: 4096 });
    assert.equal(result.status, 'success'); assert.equal(result.coverage, 'complete'); assert.equal(result.effectState, 'none');
    assert.deepEqual(result.evidence, []); assert.deepEqual(result.artifacts, []); ToolResultSchema.parse(result);
    assert.equal((publicOutput(result)['card'] as { body: string }).body, note().body);
    assert.equal(result.knowledgeDependencies?.[0]?.sources[0]?.workId, 'work-1');
    assert.doesNotMatch(JSON.stringify(result.output), /actorDigest|evidenceId|workRevision|policyDigest|knowledgeDependencies|fixture:\/\//);
    assert.equal(await h.wrapper.validate(result.knowledgeDependencies!, 'consumer', h.policy), true);
    const search = await h.invoke('core.memory.search', { namespace: 'team', query: '보존', limit: 10, maxBytes: 4096 });
    assert.equal(search.status, 'partial'); assert.equal(search.coverage, 'partial'); assert.deepEqual(publicOutput(search)['cards'], []);
    assert.equal((publicOutput(search)['index'] as { status: string }).status, 'lagging');
    await h.service.syncIndex('team');
    const found = await h.invoke('core.memory.search', { namespace: 'team', query: '보존', limit: 10, maxBytes: 4096 });
    assert.equal(found.status, 'success'); assert.equal((publicOutput(found)['cards'] as unknown[]).length, 1); ToolResultSchema.parse(found);
  });

  test(`memory tool authority intersects destination, caller and fresh trusted identity (${adapter})`, async t => {
    const h = await harness(t, adapter);
    for (const authority of ['caller', 'work', 'trusted'] as const) {
      if (authority === 'caller') h.policy.allowedLabels = [];
      if (authority === 'work') await h.mutate('consumer', s => { s.policy.allowedLabels = []; });
      if (authority === 'trusted') h.access.actor.allowedLabels = [];
      assert.equal((await h.invoke('core.memory.get', { id: 'note', maxBytes: 4096 })).status, 'error');
      h.policy.allowedLabels = ['synthetic']; h.access.actor = actor();
      if (authority === 'work') await h.mutate('consumer', s => { s.policy.allowedLabels = ['synthetic']; });
    }
    h.access.actor.principalId = 'person-b';
    assert.equal((await h.invoke('core.memory.get', { id: 'note', maxBytes: 4096 })).status, 'error');
    h.access.actor = actor();
    await h.mutate('consumer', s => { s.policy.principalId = 'person-b'; });
    const foreignPolicy = { ...h.policy, principalId: 'person-b' };
    assert.equal((await h.invoke('core.memory.get', { id: 'note', maxBytes: 4096 }, { policy: foreignPolicy })).status, 'error');
    h.access.actor = { ...actor(), tenantId: 'tenant-b' };
    assert.equal(await h.wrapper.validate([], 'consumer', foreignPolicy), false);
  });

  test(`memory reads constrain IDs and searches to the current goal scope (${adapter})`, async t => {
    const h = await harness(t, adapter); await h.service.syncIndex('team');
    await h.mutate('consumer', s => { s.goal.scope = 'elsewhere'; s.goal.revision++; });
    assert.equal((await h.invoke('core.memory.get', { id: 'note', maxBytes: 4096 })).status, 'error');
    const search = await h.invoke('core.memory.search', { namespace: 'team', query: '', limit: 10, maxBytes: 4096 });
    assert.deepEqual(publicOutput(search)['cards'], []);
    assert.equal((await h.invoke('core.memory.search', { namespace: 'team', query: '', limit: 10, maxBytes: 4096, scope: 'fixture' })).status, 'error');
  });
}

test('memory tools report bounded references without bodies, including multibyte oversized references', async t => {
  const h = await harness(t); const longId = '가'.repeat(150); await h.service.create(note(longId)); await h.service.syncIndex('team');
  const get = await h.invoke('core.memory.get', { id: longId, maxBytes: 256 });
  assert.equal(get.status, 'partial'); assert.equal(get.coverage, 'partial');
  assert.equal(publicOutput(get)['status'], 'too_large'); assert.ok(publicOutput(get)['reference']);
  assert.doesNotMatch(JSON.stringify(get.output), /"body"|"card"|관측 결과/);
  assert.ok(Buffer.byteLength(JSON.stringify(get.output)) <= 256);
  const search = await h.invoke('core.memory.search', { namespace: 'team', query: '', limit: 10, maxBytes: 256 });
  assert.equal(publicOutput(search)['status'], 'too_large'); assert.equal(search.status, 'partial');
  assert.doesNotMatch(JSON.stringify(search.output), /"body"|"cards"|관측 결과/);
  assert.ok(Buffer.byteLength(JSON.stringify(search.output)) <= 256);
});

test('memory search distinguishes result truncation and index errors from complete absence', async t => {
  const h = await harness(t); await h.service.create(note('another')); await h.service.syncIndex('team');
  const truncated = await h.invoke('core.memory.search', { namespace: 'team', query: '', limit: 1, maxBytes: 4096 });
  assert.equal(truncated.status, 'partial'); assert.equal((publicOutput(truncated)['cards'] as unknown[]).length, 1);
  await h.repository.markIndexError('tenant-a', 'team', 'index_read_failed');
  const failed = await h.invoke('core.memory.search', { namespace: 'team', query: 'no match', limit: 10, maxBytes: 4096 });
  assert.equal(failed.status, 'partial'); assert.equal((publicOutput(failed)['index'] as { status: string }).status, 'error');
});

for (const race of ['trusted-owner', 'work-owner', 'caller-labels', 'work-labels', 'goal', 'generation', 'cancel'] as const) {
  test(`memory tools discard a copied card when ${race} changes during a repository wait`, async t => {
    const h = await harness(t); const delayed = delayGet(h.repository); const wrapper = h.make({ repository: delayed.port });
    const controller = new AbortController();
    const pending = h.invoke('core.memory.get', { id: 'note', maxBytes: 4096 }, { wrapper, signal: controller.signal });
    await delayed.paused;
    if (race === 'trusted-owner') h.access.actor.principalId = 'person-b';
    if (race === 'work-owner') await h.mutate('consumer', s => { s.policy.principalId = 'person-b'; });
    if (race === 'caller-labels') h.policy.allowedLabels = [];
    if (race === 'work-labels') await h.mutate('consumer', s => { s.policy.allowedLabels = []; });
    if (race === 'goal') await h.mutate('consumer', s => { s.goal.revision++; });
    if (race === 'generation') await h.mutate('consumer', s => { s.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] }; });
    if (race === 'cancel') controller.abort();
    delayed.release(); const result = await pending;
    assert.equal(result.status, race === 'cancel' ? 'cancelled' : 'error'); assert.equal(result.output, null);
    assert.equal(result.knowledgeDependencies, undefined);
    assert.equal(result.error?.code, race === 'cancel' ? 'cancelled' : 'knowledge_unavailable');
  });
}

test('each fresh trusted actor lookup must match the work owner, including the final return check', async t => {
  const h = await harness(t); let calls = 0;
  const wrapper = h.make({ actors: { current: async () => ({ ...actor(), principalId: ++calls === 1 ? 'person-a' : 'person-b' }) } });
  const result = await h.invoke('core.memory.get', { id: 'note', maxBytes: 4096 }, { wrapper });
  assert.ok(calls >= 2); assert.equal(result.status, 'error'); assert.equal(result.output, null);
});

test('dependency validation uses current source, record and caller permissions without a stale service cache', async t => {
  const h = await harness(t); const result = await h.invoke('core.memory.get', { id: 'note', maxBytes: 4096 });
  const dependencies = result.knowledgeDependencies!;
  h.policy.allowedLabels = []; assert.equal(await h.wrapper.validate(dependencies, 'consumer', h.policy), false);
  h.policy.allowedLabels = ['synthetic']; assert.equal(await h.wrapper.validate(dependencies, 'consumer', h.policy), true);
  await h.mutate('work-1', s => { s.evidence[0]!.access = 'restricted'; });
  assert.equal(await h.wrapper.validate(dependencies, 'consumer', h.policy), false);
  assert.equal((await h.invoke('core.memory.get', { id: 'note', maxBytes: 4096 })).output, null);
});

test('memory adapters do not mutate the caller policy and normalize invalid input and pre-abort', async t => {
  const h = await harness(t); const original = structuredClone(h.policy);
  await h.invoke('core.memory.get', { id: 'note', maxBytes: 4096 }); assert.deepEqual(h.policy, original);
  for (const input of [{ id: 'note', maxBytes: 255 }, { id: 'note', maxBytes: 4096, tenantId: 'tenant-b' }, { id: 'note', maxBytes: '4096' }]) {
    const result = await h.invoke('core.memory.get', input); assert.equal(result.status, 'error'); assert.equal(result.output, null);
  }
  let actorCalls = 0; const wrapper = h.make({ actors: { current: async () => { actorCalls++; return actor(); } } });
  const controller = new AbortController(); controller.abort();
  assert.equal((await h.invoke('core.memory.get', { id: 'note', maxBytes: 4096 }, { wrapper, signal: controller.signal })).status, 'cancelled');
  assert.equal(actorCalls, 0);
});
