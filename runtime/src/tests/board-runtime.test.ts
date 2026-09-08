import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composeRuntime } from '../application/compose-runtime.js';
import { BoardWorkSourceRegistry } from '../application/board-work-source-registry.js';
import { BOARD_READ_TOOL } from '../application/board-tools.js';
import { RESOURCE_TOOL_IDS } from '../application/resource-tools.js';
import { KNOWLEDGE_TOOL_IDS } from '../application/knowledge-tools.js';
import { ToolResultSchema } from '../application/contracts.js';
import { refreshKnowledge } from '../application/knowledge-state.js';
import { buildModelContextPacket } from '../application/context-packet.js';
import type { BoardActor, BoardReadPage } from '../domain/board.js';
import type { TaskSpec, WorkState } from '../domain/model.js';
import type { BoardRepository } from '../application/board-ports.js';
import type { ReadCollectionBinding } from '../application/ports.js';
import { FileBoardRepository } from '../infrastructure/file-board.js';
import { SqliteBoardRepository } from '../infrastructure/sqlite-board.js';
import { SqliteKnowledgeRepository } from '../infrastructure/sqlite-knowledge.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner, SequenceIds } from '../infrastructure/fakes.js';
import { advance, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

const actor = (person: string): BoardActor => ({ tenantId: 'tenant-a', principalId: `person-${person}`, allowedNamespaces: ['team'],
  allowedScopes: ['fixture'], allowedLabels: ['synthetic'], canPublish: true, canReview: false, canManageBoards: person === 'a' });
const viewAccess = { channel: 'test' as const, conversationId: 'conversation-b', destination: 'local', recipientId: 'person-b', allowDiagnostics: false };
async function harness(t: TestContext, adapter: Adapter, family = 'documents', collection = false) {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-board-runtime-'));
  let state = openRepository(adapter, directory);
  const openBoard = (): BoardRepository => adapter === 'sqlite' ? new SqliteBoardRepository(join(directory, 'board.sqlite')) : new FileBoardRepository(join(directory, 'boards'));
  let repository = openBoard(); const artifacts = new FileArtifactStore(join(directory, 'artifacts'));
  const memory = new SqliteKnowledgeRepository(join(directory, 'memory.sqlite'));
  const clock = new FakeClock(1100), digester = new Sha256Digester(), ids = new SequenceIds();
  const collectionKey = { id: 'record', inputDigest: 'a'.repeat(64) };
  const binding: ReadCollectionBinding = { definition: { provider: 'fixture', id: 'fixture.collection', version: '1', effect: 'read', destination: 'local',
    description: 'Enumerate one owned fixture record', labels: ['synthetic'], inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' },
    collection: { kind: 'batch', coverage: 'manifest-v1', limits: { maxPages: 2, maxItems: 2, maxCalls: 3, maxPageBytes: 65536, maxCheckpointBytes: 262144, pageSize: 2 } } },
    source: { manifest: () => [collectionKey], fetch: async (_task, request) => ({ requestId: request.requestId, sourceSnapshot: 'fixture-snapshot',
      cursor: request.cursor, nextCursor: null, exhausted: true, totalItems: 1, expected: [collectionKey],
      items: [{ ...collectionKey, status: 'success', output: { record: 'observed' }, evidence: [], artifacts: [], coverage: 'complete', error: null }] }) } };
  const grants = new Map(['a', 'b'].map(person => [`person-${person}`, actor(person)]));
  const actors = (person: string) => ({ current: async () => structuredClone(grants.get(`person-${person}`)!) });
  const authority = { resolve: async ({ tenantId, principalId }: { tenantId: string; principalId: string }) => {
    const value = grants.get(principalId); if (!value || value.tenantId !== tenantId) return null;
    const { canManageBoards: _manage, ...trusted } = value; return structuredClone(trusted);
  } };
  const workSources = new BoardWorkSourceRegistry(); let registrations: Array<() => void> = [];
  const compose = (person: string) => composeRuntime({ services: { state, artifacts, clock, digester, ids,
    planner: new ScriptedPlanner([]), tools: [], sink: new FakeSink() }, board: { repository, workSources, actors: actors(person), authority },
    knowledge: { repository: memory, actors: { current: async () => {
      const { canManageBoards: _manage, ...value } = await actors(person).current(); return value;
    } } },
    collectionTools: collection ? [binding] : [],
    schemas: new AjvSchemas(), guidanceSource: { list: async () => [], read: async () => { throw new Error('unused'); } }, owner: `worker-${person}`, enablePlanning: false });
  for (const person of ['a', 'b']) {
    const work = initial(`work-${person}`); work.policy.principalId = `person-${person}`;
    work.conversation = { primaryBindingId: `binding-${person}`, completionRequiresDelivery: false, result: null,
      bindings: [{ id: `binding-${person}`, channel: 'test', conversationId: `conversation-${person}`, recipientId: `person-${person}`,
        destination: 'local', tenantId: 'tenant-a', principalId: `person-${person}` }] };
    work.policy.allowedTools = [BOARD_READ_TOOL, ...RESOURCE_TOOL_IDS, ...KNOWLEDGE_TOOL_IDS];
    if (collection) {
      work.policy.allowedTools.push('fixture.collection');
      if (person === 'a') work.goal.criteria[0]!.requireCollection = { queryDigest: digester.digest({ toolId: 'fixture.collection', toolVersion: '1', input: {} }) };
    }
    const raw = await artifacts.put(new TextEncoder().encode(`PRIVATE-ORIGINAL-${person}-${family}`),
      { tenantId: 'tenant-a', labels: ['synthetic'], mediaType: 'text/plain' });
    work.evidence.push({ id: 'e1', tenantId: 'tenant-a', scope: 'fixture', sourceId: `source-${person}`, lineageId: `source-${person}`,
      locator: `fixture://${family}/${person}`, observedAt: 1000, recordedAt: 1001, labels: ['synthetic'], coverage: 'complete', status: 'accepted',
      derivedFrom: [], supersedes: [], facts: { value: family === 'documents' ? '30 days' : 'normal' }, artifact: raw });
    await state.commit(command(work, `seed-${person}`));
  }
  let a = await compose('a'), b = await compose('b'), sequence = 0;
  const registerSources = () => { registrations.forEach(remove => remove());
    registrations = [a, b].map((bundle, index) => workSources.register(actor(index === 0 ? 'a' : 'b'), bundle.boardWorkSource!)); };
  registerSources();
  await a.board!.create({ id: 'board', commandId: 'create', namespace: 'team', scope: 'fixture', labels: ['synthetic'],
    roles: ['a', 'b'].map(person => ({ id: `role-${person}`, principalId: `person-${person}`, purpose: 'Investigate a generic question', active: true })),
    limits: { maxPosts: 30, maxReplies: 8, maxUnproductiveReplies: 3, maxRequests: 8 } });
  const mutation = async () => ({ boardId: 'board', expectedRevision: (await repository.get('tenant-a', 'board'))!.revision, commandId: `change-${++sequence}` });
  await a.board!.addEntity({ ...await mutation(), entity: { id: 'entity', authority: 'fixture', key: 'object-1', kind: family, title: family, validFrom: 900, validThrough: 2000 } });
  const publish = async (person: string, id: string, cited = true) => (person === 'a' ? a : b).board!.publish({ ...await mutation(), id,
    workId: `work-${person}`, entityId: 'entity', kind: cited ? 'observation' : 'hypothesis', body: `Discussion ${id}`,
    sources: cited ? [{ workId: `work-${person}`, evidenceId: 'e1' }] : [], quotedPostIds: [], labels: [], replyTo: null, relation: null, causeId: id, expiresAt: null });
  const execute = async (person: string, toolId = BOARD_READ_TOOL, input: TaskSpec['input'] = { boardId: 'board', maxPosts: 20, maxBytes: 32768 }) => {
    const bundle = person === 'a' ? a : b, workId = `work-${person}`, work = await bundle.runtime.state(workId);
    const task: TaskSpec = { id: `task-${++sequence}`, description: 'Read the next generic observation', toolId, toolVersion: '1', effect: 'read',
      input, maxAttempts: 1, dependsOn: [], satisfies: [] };
    await bundle.runtime.submitPlan(workId, `plan-${sequence}`, { baseStateRevision: work.revision, baseGoalRevision: work.goal.revision,
      basePlanRevision: work.plan?.revision ?? 0, reason: 'Inspect discussion before deciding', tasks: [task], hypotheses: work.hypotheses });
    const attempt = await bundle.runtime.reserve(workId, task.id); await bundle.runtime.execute(workId, attempt.id); await bundle.runtime.adopt(workId, attempt.id);
    const settled = await bundle.runtime.state(workId), saved = settled.attempts.find(value => value.id === attempt.id)!;
    const result = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await artifacts.get(saved.resultArtifact!, settled.policy))));
    return { state: settled, attempt: saved, result };
  };
  const changeWork = async (person: string, edit: (work: WorkState) => void) => {
    const next = advance((await state.get(`work-${person}`))!); edit(next); await state.commit(command(next, `work-${++sequence}`));
  };
  const reopen = async () => { registrations.forEach(remove => remove()); await repository.close(); await state.close(); repository = openBoard(); state = openRepository(adapter, directory); a = await compose('a'); b = await compose('b'); registerSources(); };
  t.after(async () => { registrations.forEach(remove => remove()); await state.close(); await repository.close(); await memory.close(); await rm(directory, { recursive: true, force: true }); });
  return { get a() { return a; }, get b() { return b; }, get state() { return state; }, repository: () => repository,
    artifacts, grants, actors, mutation, publish, execute, changeWork, reopen, directory,
    removeSource: (person: 'a' | 'b') => registrations[person === 'a' ? 0 : 1]!(), registerSources };
}

for (const adapter of ['sqlite', 'file-journal'] as const) {
  test(`${adapter}: shared physical storage still requires the registered foreign owner for retained board sources`, async t => {
    const h = await harness(t, adapter); await h.publish('b', 'foreign-original');
    const read = await h.execute('a'); assert.equal(read.attempt.adopted, true);
    assert.equal(await h.a.services.inputs!.current(read.state), true);
    h.removeSource('b'); assert.ok(await h.state.get('work-b'), 'the foreign row still exists in the shared physical store');
    assert.equal(await h.a.services.inputs!.current(read.state), false, 'retained input cannot fall back to the shared row');
    await assert.rejects(
      h.a.board!.readPage({ boardId: 'board', workId: 'work-a', maxPosts: 20, maxBytes: 32768 }),
      /board_unavailable/,
      'the reader retains an invalid source dependency and must be denied before page retrieval',
    );
    h.registerSources(); assert.equal(await h.a.services.inputs!.current(read.state), true);
  });

  for (const family of ['documents', 'observations']) test(`${adapter}/${family}: runtime board read retains custody through history, compact and reopen`, async t => {
    const h = await harness(t, adapter, family); await h.publish('a', 'original');
    const first = await h.execute('b');
    assert.equal(first.result.status, 'success', JSON.stringify(first.result)); assert.equal(first.attempt.adopted, true, JSON.stringify(first.attempt));
    assert.equal(first.attempt.inputDependencies?.length, 1); assert.equal(first.state.evidence.length, 1);
    assert.deepEqual(first.result.evidence, []); assert.deepEqual(first.result.artifacts, []);
    assert.doesNotMatch(JSON.stringify(first.result.output), /PRIVATE-ORIGINAL|fixture:\/\//);
    assert.deepEqual((first.result.output as unknown as BoardReadPage).posts.map(post => post.id), ['original']);
    await h.publish('a', 'later');
    assert.equal(await h.b.services.inputs!.current((await h.state.get('work-b'))!), true, 'unrelated append preserves the observed page');
    const copy = await h.execute('b', 'core.calls.get', { attemptId: first.attempt.id, maxBytes: 32768 });
    assert.equal(copy.attempt.adopted, true); assert.equal(copy.attempt.inputDependencies?.length, 1);
    assert.doesNotMatch(JSON.stringify(copy.result.output), /inputDependencies|actorDigest|"boundary"/);
    const frame = await h.b.context.prepare(copy.state, { callId: 'compact', maxInputBytes: 500000, maxInputTokens: 600000, maxOutputTokens: 1000, forceCompact: true });
    assert.doesNotMatch(JSON.stringify(frame.packet), /inputDependencies|actorDigest/);
    await h.reopen(); const resumed = await h.b.recovery.restore('work-b', actor('b'));
    assert.doesNotMatch(JSON.stringify(resumed.packet), /inputDependencies|actorDigest/);
    assert.equal(await h.b.services.inputs!.current((await h.state.get('work-b'))!), true);
    const reread = await h.b.resources.resultWithDependencies('work-b', actor('b'), first.attempt.id, 32768);
    assert.equal(reread.output.status, 'available'); assert.equal(reread.inputDependencies.length, 1);
    const view = await h.b.workView.read('work-b', actor('b'), viewAccess, { level: 'details' });
    assert.equal(view.kind, 'snapshot'); assert.doesNotMatch(JSON.stringify(view), /inputDependencies|actorDigest|PRIVATE-ORIGINAL/);
  });

  test(`${adapter}: mutual work references terminate and a revoked member invalidates the whole closure`, async t => {
    const h = await harness(t, adapter); await h.publish('a', 'a-hypothesis', false);
    assert.equal((await h.execute('b')).attempt.adopted, true); await h.publish('b', 'b-hypothesis', false);
    assert.equal((await h.execute('a')).attempt.adopted, true);
    assert.equal(await h.a.services.inputs!.current((await h.state.get('work-a'))!), true);
    assert.equal(await h.b.services.inputs!.current((await h.state.get('work-b'))!), true);
    h.grants.get('person-b')!.allowedNamespaces = [];
    assert.equal(await h.a.services.inputs!.current((await h.state.get('work-a'))!), false);
    assert.equal(await h.b.services.inputs!.current((await h.state.get('work-b'))!), false);
  });

  test(`${adapter}: private memory custody crosses a shared post without exposing the memory body`, async t => {
    const h = await harness(t, adapter), secret = 'PRIVATE-MEMORY-CONTENT';
    await h.a.knowledge!.create({ id: 'private', commandId: 'create-memory', namespace: 'team', scope: 'fixture', kind: 'experience',
      title: 'Private source', body: secret, labels: [], sources: [{ workId: 'work-a', evidenceId: 'e1' }], expiresAt: null });
    assert.equal((await h.execute('a', 'core.memory.get', { id: 'private', maxBytes: 8192 })).attempt.adopted, true);
    await h.publish('a', 'released-hypothesis', false);
    const shared = await h.execute('b'); assert.equal(shared.attempt.adopted, true);
    assert.doesNotMatch(JSON.stringify(shared.result.output), /PRIVATE-MEMORY-CONTENT|private|actorDigest|knowledgeDependencies/);
    await assert.rejects(h.b.knowledge!.get('private'));
    assert.equal(await h.b.services.inputs!.current(shared.state), true);
    await h.a.knowledge!.retract({ id: 'private', commandId: 'retract-memory', expectedRevision: 1, reason: 'Synthetic source withdrawn' });
    assert.equal(await h.b.services.inputs!.current((await h.state.get('work-b'))!), false);
  });

  test(`${adapter}: page content and consumer identity cannot be substituted in a result`, async t => {
    const h = await harness(t, adapter); await h.publish('a', 'original');
    const read = await h.execute('b'); assert.equal(read.attempt.adopted, true);
    const forged = structuredClone(read.result); (forged.output as unknown as BoardReadPage).posts[0]!.body = 'Unsupported interpretation';
    assert.equal(await h.b.contracts.validateResult(read.state, forged), false);
    const foreign = structuredClone(read.result.inputDependencies!); foreign[0]!.workId = 'work-a';
    assert.equal(await h.b.services.inputs!.validate(foreign, read.state), false);
    assert.equal(h.b.contracts.get(BOARD_READ_TOOL, '1')!.input({ boardId: 'board', maxPosts: 1, maxBytes: 4096, principalId: 'person-a' }), false);
  });

  test(`${adapter}: memory and authenticated collection inputs share the board closure without recursive full validation`, async t => {
    const h = await harness(t, adapter, 'documents', true);
    await h.a.knowledge!.create({ id: 'private', commandId: 'create-memory', namespace: 'team', scope: 'fixture', kind: 'experience',
      title: 'Private collection input', body: 'PRIVATE-COLLECTION-MEMORY', labels: [], sources: [{ workId: 'work-a', evidenceId: 'e1' }], expiresAt: null });
    assert.equal((await h.execute('a', 'core.memory.get', { id: 'private', maxBytes: 8192 })).attempt.adopted, true);
    const collected = await h.execute('a', 'fixture.collection', {}); assert.equal(collected.attempt.adopted, true, JSON.stringify(collected.result));
    assert.equal(collected.attempt.readProgress?.coverage?.complete, true);
    await h.publish('a', 'collection-interpretation', false);
    const observed = await h.execute('b'); assert.equal(observed.attempt.adopted, true);
    for (const bundle of [h.a, h.b]) bundle.services.readCoverage!.current = async () => { throw new Error('recursive_full_validator_must_not_run'); };
    assert.equal(await h.b.services.inputs!.current((await h.state.get('work-b'))!), true);
    const inspection = await h.a.services.readCoverage!.inspect!((await h.state.get('work-a'))!);
    assert.equal(inspection.knowledgeDependencies.length, 1); assert.deepEqual(inspection.sourceWorkIds, ['work-a']);
    await h.a.knowledge!.retract({ id: 'private', commandId: 'remove-private', expectedRevision: 1, reason: 'Synthetic withdrawal' });
    assert.equal(await h.b.services.inputs!.current((await h.state.get('work-b'))!), false);
  });

  test(`${adapter}: cancellation ends a board-tool wait before an unavailable repository responds`, async t => {
    const h = await harness(t, adapter); const controller = new AbortController();
    const original = h.b.services.state.get.bind(h.b.services.state); let release!: () => void, enter!: () => void;
    const started = new Promise<void>(resolve => { enter = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
    const state = (await original('work-b'))!;
    h.b.services.state.get = async id => { enter(); await blocked; return original(id); };
    const tool = h.b.contracts.get(BOARD_READ_TOOL, '1')!.tool;
    const running = tool.execute({ id: 'cancel', description: 'Cancellation fixture', toolId: BOARD_READ_TOOL, toolVersion: '1', effect: 'read',
      input: { boardId: 'board', maxPosts: 1, maxBytes: 4096 }, dependsOn: [], maxAttempts: 1, satisfies: [] },
    { workId: 'work-b', attemptId: 'cancelled', policy: state.policy, signal: controller.signal });
    try { await started; controller.abort(); const result = await running;
      assert.equal(result.status, 'cancelled'); assert.equal(result.output, null); assert.equal(result.inputDependencies, undefined);
    } finally { release(); h.b.services.state.get = original; }
  });

  test(`${adapter}: a later goal retains original input custody until copied data is quarantined`, async t => {
    const h = await harness(t, adapter); await h.publish('a', 'original');
    const read = await h.execute('b'); assert.equal(read.attempt.adopted, true);
    await h.changeWork('b', work => { work.goal.revision++; work.goal.description = 'Follow up within the same scope';
      work.plan = null; work.attempts.forEach(attempt => { attempt.adopted = false; }); });
    assert.equal(await h.b.services.inputs!.current((await h.state.get('work-b'))!), true);
    await h.a.board!.retract({ ...await h.mutation(), postId: 'original' });
    assert.equal(await h.b.services.inputs!.current((await h.state.get('work-b'))!), false);
  });

  for (const change of ['post', 'source', 'raw', 'receipt', 'role', 'authority', 'labels', 'generation', 'validator'] as const)
    test(`${adapter}: changed ${change} blocks retained board context and quarantines copied state`, async t => {
      const h = await harness(t, adapter); await h.publish('a', 'original', change !== 'generation');
      const read = await h.execute('b'); assert.equal(read.attempt.adopted, true);
      if (change === 'post') await h.a.board!.retract({ ...await h.mutation(), postId: 'original' });
      if (change === 'source') await h.changeWork('a', state => { state.evidence[0]!.status = 'retracted'; });
      if (change === 'raw' || change === 'receipt') {
        const ref = change === 'raw' ? (await h.state.get('work-a'))!.evidence[0]!.artifact! : read.attempt.inputDependencies![0]!.artifact;
        await rm(join(h.directory, 'artifacts', `${ref.id}.blob`));
      }
      if (change === 'role') await h.a.board!.setRole({ ...await h.mutation(), agentId: 'role-a', active: false });
      if (change === 'authority') h.grants.delete('person-a');
      if (change === 'labels') h.grants.get('person-a')!.allowedLabels = [];
      if (change === 'generation') await h.changeWork('a', state => { state.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] }; });
      if (change === 'validator') h.b.services.inputs = undefined;
      const current = (await h.state.get('work-b'))!;
      await assert.rejects(buildModelContextPacket(current, h.b.contracts, h.b.services));
      await assert.rejects(h.b.recovery.restore('work-b', actor('b')));
      if (change !== 'validator') await assert.rejects(h.b.workView.read('work-b', actor('b'), viewAccess, { level: 'details' }), /work_view_knowledge_changed/);
      await assert.rejects(h.b.context.prepare(current, { callId: 'blocked', maxInputBytes: 500000, maxInputTokens: 600000, maxOutputTokens: 1000 }));
      const invalid = await refreshKnowledge(h.b.services, 'work-b');
      assert.equal(invalid.status, 'blocked'); assert.equal(invalid.plan, null);
      assert.ok(invalid.attempts.every(attempt => !attempt.adopted && !attempt.inputDependencies));
      assert.ok(invalid.dataLifecycle!.blockedArtifactIds.includes(read.attempt.inputDependencies![0]!.artifact.id));
      assert.ok(invalid.evidence.every(evidence => evidence.status === 'retracted' && Object.keys(evidence.facts).length === 0));
    });
}
