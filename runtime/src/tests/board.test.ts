import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BoardService } from '../application/board-service.js';
import type { PublishBoardInput } from '../application/board-contracts.js';
import type { BoardActor, BoardState } from '../domain/board.js';
import type { BoardReadQuery } from '../domain/board.js';
import type { BoardRepository } from '../application/board-ports.js';
import type { WorkState } from '../domain/model.js';
import { FileBoardRepository } from '../infrastructure/file-board.js';
import { SqliteBoardRepository } from '../infrastructure/sqlite-board.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { FakeClock } from '../infrastructure/fakes.js';
import { SqliteKnowledgeRepository } from '../infrastructure/sqlite-knowledge.js';
import { KnowledgeService } from '../application/knowledge-service.js';
import { advance, attempt, command, initial, openRepository } from './state-conformance-helpers.js';
import type { Adapter } from './state-conformance-helpers.js';
import { evaluationCodePin } from '../infrastructure/local-evaluation.js';

const evidenceDirectory = process.env['SECUMON_BOARD_EVIDENCE_DIR'];
const codeDigest = evidenceDirectory ? (await evaluationCodePin(process.cwd())).digest : null;

const actor = (person = 'a'): BoardActor => ({ tenantId: 'tenant-a', principalId: `person-${person}`, allowedNamespaces: ['team'],
  allowedScopes: ['fixture'], allowedLabels: ['synthetic'], canPublish: true, canReview: false, canManageBoards: person === 'a' });
export const createBoardInput = { id: 'board', commandId: 'create', namespace: 'team', scope: 'fixture', labels: ['synthetic'],
  roles: [{ id: 'analyst-a', principalId: 'person-a', purpose: 'Compare observations', active: true },
    { id: 'analyst-b', principalId: 'person-b', purpose: 'Seek counterevidence', active: true }],
  limits: { maxPosts: 30, maxReplies: 8, maxUnproductiveReplies: 2, maxRequests: 8 } };

async function harness(t: TestContext, adapter: Adapter, family = 'documents', limits: Partial<BoardState['limits']> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-board-'));
  let states = openRepository(adapter, directory);
  const openBoard = () => adapter === 'sqlite' ? new SqliteBoardRepository(join(directory, 'board.sqlite')) : new FileBoardRepository(join(directory, 'boards'));
  let repository: BoardRepository = openBoard(); const artifacts = new FileArtifactStore(join(directory, 'artifacts'));
  const clock = new FakeClock(1100), digester = new Sha256Digester(), access = { actor: actor() };
  const actors = { current: async () => structuredClone(access.actor) };
  const services = { get state() { return states; }, artifacts, clock, digester };
  const make = (port: BoardRepository = repository) => new BoardService({ repository: port, actors, services });
  let board = make(); const knowledgeRepository = new SqliteKnowledgeRepository(join(directory, 'knowledge.sqlite'));
  const knowledge = () => new KnowledgeService({ repository: knowledgeRepository, states, actors: { current: async () => {
    const { canManageBoards: _manage, ...value } = await actors.current(); return value;
  } }, clock, digester });
  for (const person of ['a', 'b']) {
    const work = initial(`work-${person}`); work.policy.principalId = `person-${person}`;
    const artifact = await artifacts.put(new TextEncoder().encode(`original-${family}`), { tenantId: 'tenant-a', labels: ['synthetic'], mediaType: 'text/plain' });
    work.artifacts.push(artifact);
    work.evidence.push({ id: 'e1', tenantId: 'tenant-a', scope: 'fixture', sourceId: `${family}-original`, lineageId: `${family}-original`,
      locator: `fixture://${family}/1`, observedAt: 1000, recordedAt: 1001, labels: ['synthetic'], coverage: 'complete', status: 'accepted',
      derivedFrom: [], supersedes: [], facts: { value: family === 'documents' ? '30 days' : 'normal' }, artifact });
    await states.commit(command(work, `seed-${person}`));
  }
  await board.create({ ...createBoardInput, limits: { ...createBoardInput.limits, ...limits } });
  await board.addEntity({ boardId: 'board', expectedRevision: 1, commandId: 'entity', entity: { id: 'entity', authority: 'fixture-authority',
    key: 'same-name', kind: family, title: family, validFrom: 900, validThrough: 2000 } });
  const version = async () => (await repository.get('tenant-a', 'board'))!.revision;
  let seq = 0;
  const mutation = async () => ({ boardId: 'board', expectedRevision: await version(), commandId: `command-${++seq}` });
  const publish = async (person: string, id: string, changes: Partial<PublishBoardInput> = {}) => {
    access.actor = actor(person);
    return board.publish({ ...await mutation(), id, workId: `work-${person}`, entityId: 'entity', kind: 'observation', body: `${person} explains ${id}`,
      sources: [{ workId: `work-${person}`, evidenceId: 'e1' }], quotedPostIds: [], labels: [], replyTo: null, relation: null, causeId: id, expiresAt: null, ...changes });
  };
  const mutateWork = async (person: string, edit: (work: WorkState) => void) => {
    const next = advance((await states.get(`work-${person}`))!); edit(next); await states.commit(command(next, `work-change-${++seq}`));
  };
  const reopen = async () => { await repository.close(); await states.close(); repository = openBoard(); states = openRepository(adapter, directory); board = make(); };
  t.after(async () => { await repository.close(); await states.close(); await knowledgeRepository.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, access, clock, digester, services, artifacts, actors, make, knowledge, mutation, publish, mutateWork, reopen,
    get board() { return board; }, get repository() { return repository; }, get states() { return states; } };
}

const pageQuery: BoardReadQuery = { boardId: 'board', workId: 'work-b', maxPosts: 2, maxBytes: 8192 };
for (const adapter of ['sqlite', 'file-journal'] as const) {
  for (const family of ['documents', 'observations']) test(`${adapter}/${family}: bounded discussion pages resume after reopening with no new evidence`, async t => {
    const h = await harness(t, adapter, family);
    await h.publish('a', 'original');
    await h.publish('b', 'quote', { sources: [], quotedPostIds: ['original'] });
    await h.mutateWork('a', work => { work.evidence.push({ ...work.evidence[0]!, id: 'e2', lineageId: 'counter-source',
      sourceId: 'counter-source', facts: { value: family === 'documents' ? '90 days' : 'unexpected' } }); });
    await h.publish('a', 'counter', { sources: [{ workId: 'work-a', evidenceId: 'e2' }], kind: 'counterevidence' });
    h.access.actor = actor('b');
    const priorA = await h.states.get('work-a'), priorB = await h.states.get('work-b');
    const first = await h.board.readPage(pageQuery);
    assert.deepEqual(first.posts.map(post => post.id), ['original', 'quote']);
    assert.equal(first.findings[0]!.independentSources, 1); assert.equal(first.findings[0]!.conflicted, false);
    assert.equal(first.interpretation, 'discussion_not_independent_evidence');
    assert.equal(first.visibility, 'permitted_current_posts_only'); assert.equal(first.findingsBasis, 'returned_posts_only');
    assert.ok(first.nextCursor); assert.ok(Buffer.byteLength(JSON.stringify(first)) <= pageQuery.maxBytes);
    await h.reopen();
    const second = await h.board.readPage({ ...pageQuery, cursor: first.nextCursor });
    assert.deepEqual(second.posts.map(post => post.id), ['counter']); assert.equal(second.nextCursor, null);
    assert.equal(second.findings[0]!.independentSources, 1);
    assert.equal((await h.board.view('board')).findings[0]!.independentSources, 2);
    assert.deepEqual(await h.states.get('work-a'), priorA); assert.deepEqual(await h.states.get('work-b'), priorB);
  });

  test(`${adapter}: uncited hypotheses persist as unverified and never supply independent facts or request answers`, async t => {
    const h = await harness(t, adapter);
    await h.publish('a', 'question', { kind: 'question', sources: [] });
    await h.board.offer({ ...await h.mutation(), id: 'request', questionId: 'question', toAgentId: 'analyst-b', deliverable: 'Evidence', dueAt: 1500 });
    h.access.actor = actor('b'); await h.board.changeRequest({ ...await h.mutation(), requestId: 'request', action: 'accept', workId: 'work-b' });
    await h.publish('b', 'draft', { kind: 'hypothesis', sources: [], body: '아직 근거가 없는 경쟁 설명', replyTo: 'question', relation: 'clarifies' });
    await h.reopen(); const page = await h.board.readPage(pageQuery);
    assert.deepEqual(page.posts.map(post => post.support), ['question', 'unverified']);
    assert.equal(page.posts[1]!.referencedSources, 0); assert.deepEqual(page.posts[1]!.citations, []); assert.deepEqual(page.findings, []);
    await assert.rejects(h.board.changeRequest({ ...await h.mutation(), requestId: 'request', action: 'answer', workId: 'work-b', postId: 'draft' }), /board_unavailable/);
    for (const kind of ['observation', 'counterevidence', 'decision'] as const)
      await assert.rejects(h.publish('b', `uncited-${kind}`, { kind, sources: [] }));
    assert.equal((await h.repository.get('tenant-a', 'board'))!.posts.length, 2);
  });

  test(`${adapter}: quoted coverage remains partial or unknown instead of becoming complete`, async t => {
    const h = await harness(t, adapter);
    await h.mutateWork('a', work => { work.evidence[0]!.coverage = 'partial'; });
    await h.publish('a', 'partial');
    await h.publish('b', 'quote', { kind: 'hypothesis', sources: [], quotedPostIds: ['partial'] });
    const page = await h.board.readPage(pageQuery);
    assert.deepEqual(page.posts.map(post => post.citations[0]!.coverage), ['partial', 'partial']);
    assert.equal(page.posts[1]!.support, 'cited');
    await h.mutateWork('b', work => { work.evidence[0]!.coverage = 'unknown'; });
    await h.publish('b', 'unknown');
    assert.equal((await h.board.view('board')).posts.at(-1)!.citations[0]!.coverage, 'unknown');
    await h.mutateWork('a', work => { work.evidence[0]!.coverage = 'complete'; });
    assert.deepEqual((await h.board.readPage(pageQuery)).posts.map(post => post.id), ['unknown']);
  });

  test(`${adapter}: UTF-8 output limits retain complete posts and require a larger page for an oversized item`, async t => {
    const h = await harness(t, adapter);
    await h.publish('a', 'one', { kind: 'hypothesis', sources: [], body: '가'.repeat(500) });
    await h.publish('a', 'two', { kind: 'hypothesis', sources: [], body: '나'.repeat(500) });
    h.access.actor = actor('b');
    await assert.rejects(h.board.readPage({ ...pageQuery, maxBytes: 1024 }), /board_page_item_too_large/);
    const page = await h.board.readPage({ ...pageQuery, maxBytes: 3000 });
    assert.equal(page.posts.length, 1); assert.equal(page.posts[0]!.body, '가'.repeat(500));
    assert.ok(page.nextCursor); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 3000);
    const next = await h.board.readPage({ ...pageQuery, maxBytes: 3000, cursor: page.nextCursor });
    assert.equal(next.posts[0]!.body, '나'.repeat(500)); assert.equal(next.nextCursor, null);
  });

  test(`${adapter}: pages exclude other entity details and reject stale, foreign, and unavailable cursor positions`, async t => {
    const h = await harness(t, adapter);
    await h.board.addEntity({ ...await h.mutation(), entity: { id: 'other', authority: 'different', key: 'key', kind: 'documents',
      title: 'Other entity', validFrom: 900, validThrough: 2000 } });
    await h.publish('a', 'first'); await h.publish('a', 'other-post', { entityId: 'other' }); await h.publish('a', 'last');
    h.access.actor = actor('b');
    const filtered = await h.board.readPage({ ...pageQuery, entityId: 'entity' });
    assert.deepEqual(filtered.posts.map(post => post.id), ['first', 'last']);
    assert.deepEqual(filtered.entities.map(entity => entity.id), ['entity']); assert.equal(filtered.nextCursor, null);
    const first = await h.board.readPage({ ...pageQuery, maxPosts: 1 }); assert.ok(first.nextCursor);
    await assert.rejects(h.board.readPage({ ...pageQuery, entityId: 'other', cursor: first.nextCursor }), /board_cursor_invalid/);
    await assert.rejects(h.board.readPage({ ...pageQuery, cursor: { ...first.nextCursor, afterPostId: 'missing' } }), /board_cursor_invalid/);
    await h.mutateWork('a', work => { work.evidence[0]!.access = 'restricted'; });
    await assert.rejects(h.board.readPage({ ...pageQuery, cursor: first.nextCursor }), /board_cursor_invalid/);
    assert.deepEqual((await h.board.readPage(pageQuery)).posts, []);
    await h.publish('b', 'new');
    await assert.rejects(h.board.readPage({ ...pageQuery, cursor: first.nextCursor }), /board_cursor_stale/);
  });

  test(`${adapter}: page authority includes the consuming work and rejects invalid limits before reading`, async t => {
    const h = await harness(t, adapter); await h.publish('a', 'post'); h.access.actor = actor('b');
    await assert.rejects(h.board.readPage({ ...pageQuery, workId: 'work-a' }), /board_unavailable/);
    for (const input of [{ maxPosts: 21 }, { maxPosts: 0 }, { maxBytes: 32769 }, { maxBytes: 1023 }, { maxBytes: NaN }])
      await assert.rejects(h.board.readPage({ ...pageQuery, ...input }));
    await h.mutateWork('b', work => { work.policy.allowedLabels = []; });
    await assert.rejects(h.board.readPage(pageQuery), /board_unavailable/);
    await h.mutateWork('b', work => { work.policy.allowedLabels = ['synthetic']; work.status = 'paused'; });
    await assert.rejects(h.board.readPage(pageQuery), /board_unavailable/);
  });

  test(`${adapter}: a bounded first page reuses source reads and stops before unrelated later sources`, async t => {
    const h = await harness(t, adapter);
    for (let index = 0; index < 5; index++) {
      await h.mutateWork('a', work => { work.evidence.push({ ...work.evidence[0]!, id: `extra-${index}`, lineageId: `extra-${index}` }); });
      await h.publish('a', `post-${index}`, { sources: [{ workId: 'work-a', evidenceId: `extra-${index}` }] });
    }
    h.access.actor = actor('b'); let reads = 0;
    const artifacts = { ...h.artifacts, put: h.artifacts.put.bind(h.artifacts), exists: h.artifacts.exists.bind(h.artifacts),
      get: async (...args: Parameters<FileArtifactStore['get']>) => { reads++; return h.artifacts.get(...args); } };
    const board = new BoardService({ repository: h.repository, actors: h.actors, services: { ...h.services, artifacts } });
    const page = await board.readPage({ ...pageQuery, maxPosts: 1 });
    assert.deepEqual(page.posts.map(post => post.id), ['post-0']); assert.ok(page.nextCursor); assert.equal(reads, 2);
  });

  test(`${adapter}: a consuming work change during a page read prevents returning the stale page`, async t => {
    const h = await harness(t, adapter); await h.publish('a', 'post'); h.access.actor = actor('b'); let first = true;
    const artifacts = { put: h.artifacts.put.bind(h.artifacts), exists: h.artifacts.exists.bind(h.artifacts),
      get: async (...args: Parameters<FileArtifactStore['get']>) => {
        const bytes = await h.artifacts.get(...args);
        if (first) { first = false; await h.mutateWork('b', work => { work.status = 'paused'; }); } return bytes;
      } };
    const board = new BoardService({ repository: h.repository, actors: h.actors, services: { ...h.services, artifacts } });
    await assert.rejects(board.readPage(pageQuery), /board_contention/);
  });

  test(`${adapter}: removing citations does not bypass the author's retained memory dependencies`, async t => {
    const h = await harness(t, adapter);
    const memory = await h.knowledge().create({ id: 'memory', commandId: 'remember', namespace: 'team', scope: 'fixture', kind: 'experience',
      title: 'Source observation', body: 'An observation used in a draft', sources: [{ workId: 'work-a', evidenceId: 'e1' }], labels: [], expiresAt: null });
    await h.mutateWork('a', work => { work.attempts.push({ ...attempt('succeeded'), finishedAt: 1001, knowledgeDependencies: [memory.dependency] }); });
    const board = new BoardService({ repository: h.repository, actors: h.actors, services: { ...h.services,
      knowledge: { validate: dependencies => h.knowledge().validateDependencies(dependencies) } } });
    const publish = async (id: string) => board.publish({ ...await h.mutation(), id, workId: 'work-a', entityId: 'entity',
      kind: 'hypothesis', body: 'An unverified explanation', sources: [], labels: [], replyTo: null, relation: null, causeId: id, expiresAt: null });
    await publish('draft');
    assert.equal((await board.view('board')).posts[0]!.support, 'unverified');
    await h.mutateWork('a', work => { work.evidence[0]!.access = 'restricted'; });
    assert.deepEqual((await board.view('board')).posts, []);
    await assert.rejects(publish('later-draft'), /board_unavailable/);
    await assert.rejects(board.readPage({ ...pageQuery, workId: 'work-a' }), /board_unavailable/);
  });
}

for (const adapter of ['sqlite', 'file-journal'] as const) {
  for (const family of ['documents', 'observations']) test(`${adapter}/${family}: two persistent roles share citations without publishing private memory or inflating sources`, async t => {
    const h = await harness(t, adapter, family);
    await h.knowledge().create({ id: 'private', commandId: 'remember', namespace: 'team', scope: 'fixture', kind: 'experience',
      title: 'Private observation', body: 'PRIVATE draft not for the board', sources: [{ workId: 'work-a', evidenceId: 'e1' }], labels: [], expiresAt: null });
    await h.publish('a', 'first');
    await h.publish('b', 'quote', { sources: [], quotedPostIds: ['first'], replyTo: 'first', relation: 'supports' });
    await assert.rejects(h.knowledge().get('private'), /knowledge_unavailable/);
    let view = await h.board.view('board'); assert.equal(view.roleId, 'analyst-b'); assert.equal(view.posts.length, 2);
    assert.equal(view.findings[0]!.independentSources, 1); assert.ok(!JSON.stringify(view).includes('PRIVATE'));
    assert.equal(view.posts[1]!.citations[0]!.workId, 'work-a');
    await h.mutateWork('b', work => { work.evidence.push({ ...work.evidence[0]!, id: 'e2', sourceId: `${family}-second`, lineageId: `${family}-second`,
      facts: { value: family === 'documents' ? '90 days' : 'unexpected' } }); });
    await h.publish('b', 'counter', { sources: [{ workId: 'work-b', evidenceId: 'e2' }], kind: 'counterevidence', replyTo: 'first', relation: 'contradicts' });
    view = await h.board.view('board'); assert.equal(view.findings[0]!.independentSources, 2); assert.equal(view.findings[0]!.conflicted, true);
    const prior = structuredClone(view); await h.reopen(); assert.deepEqual(await h.board.view('board'), prior);
    assert.equal((await h.states.get('work-a'))!.evidence.length, 1); assert.equal((await h.states.get('work-b'))!.evidence.length, 2);
    if (evidenceDirectory) {
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(join(evidenceDirectory, `${adapter}-${family}.json`), JSON.stringify({ codeDigest, backend: adapter, family,
        actualModelCalls: 0, runtimeToolIntegration: 'pending', privateMemoryVisible: false, quotedSourceWorkId: view.posts[1]!.citations[0]!.workId,
        originalSourcesAfterQuote: 1, sourcesAfterCounterevidence: 2, conflictRetained: true, reopenedViewMatches: true, view }, null, 2) + '\n', { flag: 'wx' });
    }
  });

  test(`${adapter}: direct source sharing requires source ownership; quotes require a currently visible post`, async t => {
    const h = await harness(t, adapter);
    await assert.rejects(h.publish('b', 'stolen', { sources: [{ workId: 'work-a', evidenceId: 'e1' }] }), /board_unavailable/);
    await h.publish('a', 'original');
    h.access.actor = { ...actor('b'), allowedLabels: [] }; await assert.rejects(h.board.view('board'), /board_unavailable/);
    h.access.actor = { ...actor('b'), tenantId: 'other' }; await assert.rejects(h.board.view('board'), /board_unavailable/);
    h.access.actor = actor('outsider'); await assert.rejects(h.board.view('board'), /board_unavailable/);
    h.access.actor = actor(); await h.board.setRole({ ...await h.mutation(), agentId: 'analyst-b', active: false });
    await assert.rejects(h.publish('b', 'disabled', { sources: [], quotedPostIds: ['original'] }), /board_unavailable/);
    await assert.rejects(h.board.view('board'), /board_unavailable/);
  });

  for (const change of ['retract-post', 'restrict-source', 'change-goal', 'delete-original', 'expire']) test(`${adapter}: ${change} removes the claim and its quoted descendants from current views`, async t => {
    const h = await harness(t, adapter);
    await h.publish('a', 'original', { expiresAt: change === 'expire' ? 1200 : null });
    await h.publish('b', 'quote', { sources: [], quotedPostIds: ['original'] });
    if (change === 'retract-post') { h.access.actor = actor(); await h.board.retract({ ...await h.mutation(), postId: 'original' }); }
    else if (change === 'restrict-source') await h.mutateWork('a', work => { work.evidence[0]!.access = 'restricted'; });
    else if (change === 'change-goal') await h.mutateWork('a', work => { work.goal.revision++; });
    else if (change === 'expire') h.clock.advance(100);
    else {
      const ref = (await h.states.get('work-a'))!.evidence[0]!.artifact!;
      const port = new Proxy(h.artifacts, { get(target, key) {
        if (key === 'get') return async (value: typeof ref, policy: WorkState['policy']) => { if (value.id === ref.id) throw new Error('artifact_unavailable'); return target.get(value, policy); };
        const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
      const service = new BoardService({ repository: h.repository, actors: h.actors, services: { ...h.services, artifacts: port } });
      assert.equal((await service.view('board')).posts.length, 0); return;
    }
    h.access.actor = actor('b'); const view = await h.board.view('board'); assert.equal(view.posts.length, 0); assert.equal(view.findings.length, 0);
    assert.equal((await h.repository.get('tenant-a', 'board'))!.posts.length, 2);
  });

  test(`${adapter}: an entity with the same key in a different time scope stays separate`, async t => {
    const h = await harness(t, adapter);
    await h.board.addEntity({ ...await h.mutation(), entity: { id: 'later', authority: 'fixture-authority', key: 'same-name', kind: 'asset', title: 'Later occupant', validFrom: 2000, validThrough: null } });
    await assert.rejects(h.publish('a', 'wrong-period', { entityId: 'later' }), /board_unavailable/);
    await assert.rejects(h.board.addEntity({ ...await h.mutation(), entity: { id: 'duplicate', authority: 'fixture-authority', key: 'same-name', kind: 'asset', title: 'Duplicate alias', validFrom: 900, validThrough: 2000 } }));
    assert.equal((await h.board.view('board')).entities.length, 2);
  });

  test(`${adapter}: publishing a question does not assign it; acceptance, response and requester confirmation remain distinct`, async t => {
    const h = await harness(t, adapter);
    await h.publish('a', 'question', { kind: 'question', sources: [] }); assert.deepEqual((await h.board.view('board')).requests, []);
    await h.board.offer({ ...await h.mutation(), id: 'request', questionId: 'question', toAgentId: 'analyst-b', deliverable: 'Find a cited comparison', dueAt: 5000 });
    await assert.rejects(h.board.changeRequest({ ...await h.mutation(), requestId: 'request', action: 'accept', workId: 'work-a' }), /board_unavailable/);
    h.access.actor = actor('b'); await h.board.changeRequest({ ...await h.mutation(), requestId: 'request', action: 'accept', workId: 'work-b' });
    assert.equal((await h.board.view('board')).requests[0]!.status, 'accepted');
    await h.publish('b', 'answer', { replyTo: 'question', relation: 'clarifies' });
    await h.board.changeRequest({ ...await h.mutation(), requestId: 'request', action: 'answer', postId: 'answer' });
    assert.equal((await h.board.view('board')).requests[0]!.effectiveStatus, 'answered');
    await assert.rejects(h.board.changeRequest({ ...await h.mutation(), requestId: 'request', action: 'confirm' }), /board_unavailable/);
    h.access.actor = actor(); await h.board.changeRequest({ ...await h.mutation(), requestId: 'request', action: 'confirm' });
    assert.equal((await h.board.view('board')).requests[0]!.effectiveStatus, 'satisfied');
    await h.mutateWork('b', work => { work.evidence[0]!.status = 'retracted'; });
    assert.equal((await h.board.view('board')).requests[0]!.effectiveStatus, 'needs_review');
    assert.notEqual((await h.states.get('work-a'))!.status, 'completed');
  });

  test(`${adapter}: repeated replies and explicit cyclic waits are bounded; deadlines do not reset on reopen`, async t => {
    const h = await harness(t, adapter);
    await h.publish('a', 'a-question', { kind: 'question', sources: [] });
    await h.board.offer({ ...await h.mutation(), id: 'a-request', questionId: 'a-question', toAgentId: 'analyst-b', deliverable: 'Check A', dueAt: 5000 });
    await h.publish('b', 'b-question', { kind: 'question', sources: [] });
    await h.board.offer({ ...await h.mutation(), id: 'b-request', questionId: 'b-question', toAgentId: 'analyst-a', deliverable: 'Check B', dueAt: 5000 });
    await h.board.changeRequest({ ...await h.mutation(), requestId: 'a-request', action: 'accept', workId: 'work-b' });
    h.access.actor = actor(); await h.board.changeRequest({ ...await h.mutation(), requestId: 'b-request', action: 'accept', workId: 'work-a' });
    await h.board.changeRequest({ ...await h.mutation(), requestId: 'b-request', action: 'wait', waitFor: ['a-request'] });
    h.access.actor = actor('b'); await assert.rejects(h.board.changeRequest({ ...await h.mutation(), requestId: 'a-request', action: 'wait', waitFor: ['b-request'] }), /board_wait_cycle/);
    await h.publish('b', 'repeat1', { kind: 'question', sources: [], replyTo: 'a-question', relation: 'clarifies' });
    await h.publish('a', 'repeat2', { kind: 'question', sources: [], replyTo: 'repeat1', relation: 'clarifies' });
    await assert.rejects(h.publish('b', 'repeat3', { kind: 'question', sources: [], replyTo: 'repeat2', relation: 'clarifies' }), /board_no_progress/);
    h.clock.advance(3900); await h.reopen(); assert.ok((await h.board.view('board')).requests.every(value => value.effectiveStatus === 'expired'));
    await assert.rejects(h.board.changeRequest({ ...await h.mutation(), requestId: 'a-request', action: 'answer', postId: 'repeat1' }), /board_unavailable/);
    await h.board.changeRequest({ ...await h.mutation(), requestId: 'a-request', action: 'decline' });
    await h.board.changeRequest({ ...await h.mutation(), requestId: 'b-request', action: 'cancel' });
    const closed = (await h.board.view('board')).requests;
    assert.equal(closed.find(value => value.id === 'a-request')!.status, 'declined');
    assert.equal(closed.find(value => value.id === 'b-request')!.effectiveStatus, 'cancelled');
    assert.ok(closed.every(value => value.dueAt === 5000));
  });

  test(`${adapter}: exact command retry survives a lost reply; reused IDs with changed content and concurrent edits fail`, async t => {
    const h = await harness(t, adapter); let loseReply = true;
    const wrapped = new Proxy(h.repository, { get(target, key) {
      if (key === 'commit') return async (...args: Parameters<BoardRepository['commit']>) => {
        const value = await target.commit(...args); if (loseReply) { loseReply = false; throw new Error('simulated_reply_loss'); } return value;
      };
      const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const args = { ...await h.mutation(), agentId: 'analyst-b', active: false };
    await assert.rejects(h.make(wrapped).setRole(args), /simulated_reply_loss/); await h.reopen();
    assert.equal((await h.board.setRole(args)).duplicate, true);
    await assert.rejects(h.board.setRole({ ...args, active: true }), /board_command_conflict/);
    const revision = (await h.repository.get('tenant-a', 'board'))!.revision;
    const attempts = await Promise.allSettled([h.board.setRole({ boardId: 'board', expectedRevision: revision, commandId: 'race-one', agentId: 'analyst-b', active: true }),
      h.board.setRole({ boardId: 'board', expectedRevision: revision, commandId: 'race-two', agentId: 'analyst-b', active: false })]);
    assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1); assert.equal(attempts.filter(value => value.status === 'rejected').length, 1);
  });

  test(`${adapter}: authority changing during a source read cannot publish or return the delayed content`, async t => {
    const h = await harness(t, adapter); await h.publish('a', 'original');
    let trigger = true;
    const artifacts = new Proxy(h.artifacts, { get(target, key) {
      if (key === 'get') return async (...args: Parameters<FileArtifactStore['get']>) => {
        const value = await target.get(...args); if (trigger) { trigger = false; h.access.actor.allowedLabels = []; } return value;
      };
      const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const service = new BoardService({ repository: h.repository, actors: h.actors, services: { ...h.services, artifacts } });
    await assert.rejects(service.view('board'), /board_unavailable/);
    h.access.actor = actor(); trigger = true; const before = (await h.repository.get('tenant-a', 'board'))!.revision;
    await assert.rejects(service.publish({ ...await h.mutation(), id: 'late', workId: 'work-a', entityId: 'entity', kind: 'observation', body: 'do not publish',
      labels: [], sources: [{ workId: 'work-a', evidenceId: 'e1' }], replyTo: null, relation: null, causeId: 'late', expiresAt: null }), /board_unavailable/);
    assert.equal((await h.repository.get('tenant-a', 'board'))!.revision, before);
  });

  test(`${adapter}: a derived claim retains ancestry without becoming another independent fact source`, async t => {
    const h = await harness(t, adapter);
    await h.mutateWork('a', work => { work.evidence.push({ ...work.evidence[0]!, id: 'derived', derivedFrom: ['e1'], facts: { inference: 'candidate explanation' } }); });
    await h.publish('a', 'hypothesis', { kind: 'hypothesis', sources: [{ workId: 'work-a', evidenceId: 'derived' }] });
    const view = await h.board.view('board'); assert.equal(view.posts[0]!.referencedSources, 1);
    assert.equal(view.findings.find(row => row.key === 'inference')!.independentSources, 0);
  });

  test(`${adapter}: repeated quotes share one source read within a view and a later view revalidates it`, async t => {
    const h = await harness(t, adapter); await h.publish('a', 'original');
    for (let index = 0; index < 3; index++) await h.publish('b', `quote-${index}`, { sources: [], quotedPostIds: ['original'] });
    h.artifacts.resetMetrics(); const view = await h.board.view('board');
    assert.equal(view.posts.length, 4); assert.equal(view.findings[0]!.independentSources, 1); assert.equal(h.artifacts.metrics().getCalls, 1);
    await h.mutateWork('a', work => { work.evidence[0]!.access = 'restricted'; });
    assert.equal((await h.board.view('board')).posts.length, 0);
  });

  test(`${adapter}: unlabelled prose inherits the author's work labels and current exchange policy`, async t => {
    const h = await harness(t, adapter);
    await h.mutateWork('a', work => { work.policy.allowedLabels.push('private'); work.disclosureLabels = ['synthetic', 'private']; });
    h.access.actor = { ...actor(), allowedLabels: ['synthetic', 'private'] };
    const input = { ...await h.mutation(), id: 'classified', workId: 'work-a', entityId: 'entity', kind: 'observation' as const,
      body: 'Potentially private prose', labels: [], sources: [{ workId: 'work-a', evidenceId: 'e1' }], replyTo: null, relation: null, causeId: 'classified', expiresAt: null };
    await h.board.publish(input); h.access.actor = actor('b'); assert.deepEqual((await h.board.view('board')).posts, []);
    await h.mutateWork('a', work => { work.policy.disclosure = { revision: 'no-exchange', destinations: [{ destination: 'local', surfaces: ['model'], allowedLabels: ['synthetic', 'private'] }], maxReleasesPerWork: 10, maxReleasedBytesPerWork: 10000 };
      work.disclosureLabels = ['synthetic', 'private']; });
    h.access.actor = { ...actor(), allowedLabels: ['synthetic', 'private'] };
    assert.equal((await h.board.view('board')).posts.length, 0);
    await assert.rejects(h.board.publish({ ...input, ...await h.mutation(), id: 'denied', causeId: 'denied' }), /board_unavailable/);
  });

  test(`${adapter}: a fulfilled dependency remains attached and its later retraction invalidates dependent confirmation`, async t => {
    const h = await harness(t, adapter);
    await h.publish('a', 'qa', { kind: 'question', sources: [] });
    await h.board.offer({ ...await h.mutation(), id: 'ra', questionId: 'qa', toAgentId: 'analyst-b', deliverable: 'A answer', dueAt: 5000 });
    await h.publish('b', 'qb', { kind: 'question', sources: [] });
    await h.board.offer({ ...await h.mutation(), id: 'rb', questionId: 'qb', toAgentId: 'analyst-a', deliverable: 'B answer', dueAt: 5000 });
    await h.board.changeRequest({ ...await h.mutation(), requestId: 'ra', action: 'accept', workId: 'work-b' });
    h.access.actor = actor(); await h.board.changeRequest({ ...await h.mutation(), requestId: 'rb', action: 'accept', workId: 'work-a' });
    h.access.actor = actor('b'); await h.board.changeRequest({ ...await h.mutation(), requestId: 'ra', action: 'wait', waitFor: ['rb'] });
    await h.publish('a', 'answer-b', { replyTo: 'qb', relation: 'clarifies' });
    await h.board.changeRequest({ ...await h.mutation(), requestId: 'rb', action: 'answer', postId: 'answer-b' });
    h.access.actor = actor('b'); await h.board.changeRequest({ ...await h.mutation(), requestId: 'rb', action: 'confirm' });
    await h.publish('b', 'answer-a', { replyTo: 'qa', relation: 'clarifies' });
    await h.board.changeRequest({ ...await h.mutation(), requestId: 'ra', action: 'answer', postId: 'answer-a' });
    h.access.actor = actor(); await h.board.changeRequest({ ...await h.mutation(), requestId: 'ra', action: 'confirm' });
    assert.deepEqual((await h.board.view('board')).requests.find(value => value.id === 'ra')!.waitFor, ['rb']);
    await h.board.retract({ ...await h.mutation(), postId: 'answer-b' });
    const view = await h.board.view('board'); assert.ok(view.requests.every(value => value.effectiveStatus === 'needs_review'));
  });

  test(`${adapter}: reply depth, total posts, total requests and repeated causes have separate limits`, async t => {
    const h = await harness(t, adapter, 'documents', { maxPosts: 3, maxReplies: 1, maxRequests: 1 });
    await h.publish('a', 'q', { kind: 'question', sources: [] });
    await h.publish('b', 'reply', { kind: 'question', sources: [], replyTo: 'q', relation: 'clarifies' });
    await assert.rejects(h.publish('a', 'too-deep', { kind: 'question', sources: [], replyTo: 'reply', relation: 'clarifies' }), /board_reply_limit/);
    await h.board.offer({ ...await h.mutation(), id: 'one', questionId: 'q', toAgentId: 'analyst-b', deliverable: 'One answer', dueAt: 5000 });
    await assert.rejects(h.board.offer({ ...await h.mutation(), id: 'two', questionId: 'q', toAgentId: 'analyst-b', deliverable: 'Second request', dueAt: 5000 }), /board_request_limit/);
    await assert.rejects(h.publish('a', 'same-cause', { causeId: 'q' }), /board_cause_duplicate/);
    await h.publish('a', 'third'); await assert.rejects(h.publish('b', 'fourth'), /board_post_limit/);
    assert.equal((await h.repository.get('tenant-a', 'board'))!.posts.length, 3);
  });

  test(`${adapter}: an advancing clock permits ordinary writes and blocks a post expiring during the final boundary check`, async t => {
    const h = await harness(t, adapter);
    let expire = false;
    const actors = { current: async () => { h.clock.advance(expire ? 100 : 1); return structuredClone(h.access.actor); } };
    const board = new BoardService({ repository: h.repository, actors, services: h.services });
    await board.addEntity({ ...await h.mutation(), entity: { id: 'clock-entity', authority: 'clock', key: 'clock', title: 'Clock test', kind: 'record', validFrom: 900, validThrough: null } });
    const base = { ...await h.mutation(), id: 'clock-post', workId: 'work-a', entityId: 'entity', kind: 'observation' as const, body: 'clock moves while reading',
      labels: [], sources: [{ workId: 'work-a', evidenceId: 'e1' }], replyTo: null, relation: null, causeId: 'clock-post', expiresAt: null };
    await board.publish(base); assert.equal((await board.view('board')).posts.length, 1);
    expire = true;
    await assert.rejects(board.publish({ ...base, ...await h.mutation(), id: 'expires', causeId: 'expires', expiresAt: h.clock.now() + 150 }), /board_contention/);
    assert.equal((await h.repository.get('tenant-a', 'board'))!.posts.length, 1);
  });

  test(`${adapter}: a paused assignee cannot have its submitted answer confirmed`, async t => {
    const h = await harness(t, adapter);
    await h.publish('a', 'question', { kind: 'question', sources: [] });
    await h.board.offer({ ...await h.mutation(), id: 'request', questionId: 'question', toAgentId: 'analyst-b', deliverable: 'Cited answer', dueAt: 5000 });
    h.access.actor = actor('b'); await h.board.changeRequest({ ...await h.mutation(), requestId: 'request', action: 'accept', workId: 'work-b' });
    await h.publish('b', 'answer', { replyTo: 'question', relation: 'clarifies' });
    await h.board.changeRequest({ ...await h.mutation(), requestId: 'request', action: 'answer', postId: 'answer' });
    await h.mutateWork('b', work => { work.status = 'paused'; }); h.access.actor = actor();
    await assert.rejects(h.board.changeRequest({ ...await h.mutation(), requestId: 'request', action: 'confirm' }), /board_unavailable/);
    assert.equal((await h.board.view('board')).requests[0]!.effectiveStatus, 'needs_review');
  });

  test(`${adapter}: an actual worker SIGKILL after durable publication preserves one post and one command receipt`, { timeout: 15000 }, async t => {
    const h = await harness(t, adapter); await h.publish('a', 'original');
    const prior = (await h.repository.get('tenant-a', 'board'))!, next = structuredClone(prior); next.revision++;
    next.posts.push({ ...next.posts[0]!, id: 'worker-post', causeId: 'worker-post' });
    const input = { expectedRevision: prior.revision, commandId: 'worker-publish', commandDigest: h.digester.digest({ action: 'worker-publish' }), next };
    const child = fork(new URL('./helpers/board-worker.js', import.meta.url), [adapter, h.directory], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const message = new Promise<{ kind: string; revision: number; pid: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('board_worker_timeout')), 8000);
      child.once('message', value => { clearTimeout(timer); resolve(value as { kind: string; revision: number; pid: number }); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('board_worker_early_exit')); });
    });
    child.send(input); const ready = await message; assert.equal(ready.kind, 'committed'); assert.equal(ready.revision, next.revision);
    const exited = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('board_worker_exit_timeout')), 5000);
      child.once('exit', (_code, signal) => { clearTimeout(timer); if (signal !== 'SIGKILL') reject(new Error('board_worker_wrong_signal')); else resolve(); });
    });
    child.kill('SIGKILL'); await exited;
    assert.throws(() => process.kill(ready.pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
    await h.reopen(); assert.equal((await h.repository.commit(input)).kind, 'duplicate');
    const view = await h.board.view('board'); assert.equal(view.posts.length, 2); assert.equal(view.findings[0]!.independentSources, 1);
  });
}

test('file board journal detects missing revisions and changed content instead of returning a partial history', async t => {
  const h = await harness(t, 'file-journal'); await h.publish('a', 'post');
  const root = join(h.directory, 'boards'), names = (await readdir(root)).filter(name => name.endsWith('.json')).sort();
  const first = join(root, names[0]!), original = await readFile(first, 'utf8');
  const value = JSON.parse(original) as { command: { next: BoardState } }; value.command.next.roles[0]!.purpose = 'changed';
  await writeFile(first, JSON.stringify(value)); await assert.rejects(h.board.view('board'), /board_journal_corrupt/);
  await writeFile(first, original); await rm(first); await assert.rejects(h.board.view('board'), /board_journal_gap/);
});
