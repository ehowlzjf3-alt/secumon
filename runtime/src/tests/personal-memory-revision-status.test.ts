import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeService } from '../application/knowledge-service.js';
import { SessionKnowledgeSources } from '../application/session-knowledge-sources.js';
import type { KnowledgeRepository } from '../application/knowledge-ports.js';
import type { TrustedKnowledgeActor } from '../domain/knowledge.js';
import { actor, initialize, open, request, scenario } from './session-flow-helpers.js';

const original = '개인 기억에는 간단한 한국어 답변 형식을 저장한다.';
const corrected = '개인 기억에는 한국어 설명과 확인한 근거를 함께 저장한다.';

async function fixture(t: TestContext, personalMemory: 'sqlite' | 'documents' = 'sqlite') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'personal-revision-status-')));
  mkdirSync(join(base, 'engine'), { mode: 0o700 }); initialize(base, 'sqlite', 'agent', personalMemory);
  let f = await open(base);
  t.after(async () => { try { await f.close(); } finally { rmSync(base, { recursive: true, force: true }); } });
  const session = await f.sessions!.open(actor, { channel: 'test', conversationId: 'status-source' });
  const accepted = await f.sessions!.accept(actor, { sessionId: session.scope.sessionId, rawText: original, request: request('original') });
  const access: { actor: TrustedKnowledgeActor; forbidSources: boolean; captures: number; currents: number; commits: number } = {
    actor: { ...actor, agentId: f.stores.profile.identity.agentId, allowedLabels: [...scenario.policy.allowedLabels],
      allowedDestinations: [...scenario.policy.allowedDestinations], allowedNamespaces: ['personal'], allowedScopes: [scenario.goal.scope], canReview: false, canPublish: false },
    forbidSources: false, captures: 0, currents: 0, commits: 0,
  };
  const makeRoot = (repository: KnowledgeRepository = f.stores.knowledge) => {
    const source = new SessionKnowledgeSources(f.services, f.stores.sessions, f.stores.profile.identity.agentId);
    return new KnowledgeService({ repository: { get: repository.get.bind(repository), receipt: repository.receipt.bind(repository),
      commit: async command => { access.commits++; return repository.commit(command); }, indexHead: repository.indexHead.bind(repository),
      candidates: repository.candidates.bind(repository), rebuildIndex: repository.rebuildIndex.bind(repository), markIndexError: repository.markIndexError.bind(repository), close: async () => {} },
    states: f.stores.state, clock: f.services.clock, digester: f.services.digester, actors: { current: async () => structuredClone(access.actor) },
    userSources: { capture: async (...args) => { access.captures++; if (access.forbidSources) throw new Error('unexpected_source_capture'); return source.capture(...args); },
      current: async (...args) => { access.currents++; if (access.forbidSources) throw new Error('unexpected_source_current'); return source.current(...args); } } });
  };
  let root = makeRoot(), memory = await root.forPersonal(actor);
  await memory.remember({ id: 'format', commandId: 'remember', title: '답변 형식', source: { sessionId: session.scope.sessionId, messageId: 'original', quote: original } });
  await f.sessions!.inputOnly(actor, { sessionId: session.scope.sessionId, workId: accepted.workId, messageId: 'correction', rawText: corrected, expectedGoalRevision: 1 });
  const correction = { id: 'format', commandId: 'correct-v2', expectedRevision: 1, title: '정정한 형식', reason: '사용자 정정',
    source: { sessionId: session.scope.sessionId, messageId: 'correction', quote: corrected } };
  return { base, session, accepted, access, correction, makeRoot,
    get f() { return f; }, get root() { return root; }, get memory() { return memory; },
    async close() { await f.close(); },
    async reopen() { f = await open(base); root = makeRoot(); memory = await root.forPersonal(actor); },
  };
}

for (const backend of ['sqlite', 'documents'] as const) {
  test(`${backend}: a correction receipt reports its original revision after later correction and forgetting`, async t => {
    const h = await fixture(t, backend);
    assert.equal(await h.memory.revisePersonalStatus(h.correction), null);
    assert.deepEqual(await h.memory.revisePersonal(h.correction), { id: 'format', revision: 2 });
    const next = { ...h.correction, commandId: 'correct-v3', expectedRevision: 2, title: '최종 형식' };
    assert.deepEqual(await h.memory.revisePersonal(next), { id: 'format', revision: 3 });
    await h.reopen();
    h.access.forbidSources = true;
    const before = { captures: h.access.captures, currents: h.access.currents, commits: h.access.commits };
    assert.deepEqual(await h.memory.revisePersonalStatus(h.correction), { id: 'format', revision: 2, currentRevision: 3, currentStatus: 'active' });
    assert.deepEqual(await h.memory.revisePersonal(h.correction), { id: 'format', revision: 2 });
    assert.deepEqual({ captures: h.access.captures, currents: h.access.currents, commits: h.access.commits }, before);
    await h.memory.forgetPersonal({ id: 'format', commandId: 'forget-v4', expectedRevision: 3, reason: '사용자 잊기' });
    assert.deepEqual(await h.memory.revisePersonalStatus(h.correction), { id: 'format', revision: 2, currentRevision: 4, currentStatus: 'deleted' });
    assert.deepEqual(await h.memory.revisePersonal(h.correction), { id: 'format', revision: 2 });
    assert.equal((await h.f.stores.sessions.input(h.session.scope, 'correction'))!.text, corrected);
    const state = await h.f.runtime.state(h.accepted.workId);
    assert.equal(state.evidence.length, 0); assert.equal(state.modelCalls.length, 0); assert.equal(state.attempts.length, 0);
  });
}

test('revision status checks the entire original command and returns no source or body fields', async t => {
  const h = await fixture(t); await h.memory.revisePersonal(h.correction); h.access.forbidSources = true;
  for (const changed of [{ ...h.correction, reason: '다른 이유' }, { ...h.correction, title: '다른 제목' },
    { ...h.correction, expectedRevision: 2 }, { ...h.correction, source: { ...h.correction.source, quote: '다른 원문' } }]) {
    await assert.rejects(h.memory.revisePersonalStatus(changed), /knowledge_command_conflict/);
  }
  const status = await h.memory.revisePersonalStatus(h.correction);
  assert.deepEqual(Object.keys(status!).sort(), ['currentRevision', 'currentStatus', 'id', 'revision']);
  assert.equal(JSON.stringify(status).includes(corrected), false);
  assert.equal(await h.memory.revisePersonalStatus({ ...h.correction, commandId: 'never-applied' }), null);
  assert.equal(await h.memory.revisePersonalStatus({ ...h.correction, id: 'absent' }), null);
});

test('duplicate correction joins an original commit that finishes after its initial record read', async t => {
  const h = await fixture(t), repository = h.f.stores.knowledge;
  let committed = false;
  const interleaved: KnowledgeRepository = { get: async (...args) => {
    const prior = await repository.get(...args);
    if (!committed) { committed = true; await h.memory.revisePersonal(h.correction); h.access.forbidSources = true; }
    return prior;
  }, receipt: repository.receipt.bind(repository), commit: repository.commit.bind(repository), indexHead: repository.indexHead.bind(repository),
  candidates: repository.candidates.bind(repository), rebuildIndex: repository.rebuildIndex.bind(repository), markIndexError: repository.markIndexError.bind(repository), close: async () => {} };
  const competing = await h.makeRoot(interleaved).forPersonal(actor);
  assert.deepEqual(await competing.revisePersonal(h.correction), { id: 'format', revision: 2 });
  assert.equal(h.access.commits, 2, 'one remember and one correction commit, no competing second correction');
  assert.deepEqual(await competing.revisePersonalStatus(h.correction), { id: 'format', revision: 2, currentRevision: 2, currentStatus: 'active' });
});

test('revision status hides current metadata after label narrowing and rejects namespace or host-owner loss', async t => {
  const h = await fixture(t); await h.memory.revisePersonal(h.correction); h.access.forbidSources = true;
  const limited = await h.root.forPersonal({ ...actor, allowedLabels: [] });
  assert.deepEqual(await limited.revisePersonalStatus(h.correction), { id: 'format', revision: 2, currentRevision: null, currentStatus: null });
  h.access.actor.allowedNamespaces = [];
  await assert.rejects(h.memory.revisePersonalStatus(h.correction), /knowledge_unavailable/);
  await assert.rejects(h.memory.revisePersonal(h.correction), /knowledge_unavailable/);
  h.access.actor.allowedNamespaces = ['personal'];
  const originalActor = structuredClone(h.access.actor);
  for (const change of [{ principalId: 'other-user' }, { tenantId: 'other-tenant' }, { agentId: 'other-agent' }]) {
    h.access.actor = { ...originalActor, ...change };
    await assert.rejects(h.memory.revisePersonalStatus(h.correction), /knowledge_unavailable/);
    const other = await h.makeRoot().forPersonal();
    if ('agentId' in change) await assert.rejects(other.revisePersonalStatus(h.correction), /knowledge_scope_mismatch/);
    else assert.equal(await other.revisePersonalStatus(h.correction), null);
  }
});

test('revision status rechecks authority after storage and rejects a forged receipt revision or owner', async t => {
  const h = await fixture(t); await h.memory.revisePersonal(h.correction); h.access.forbidSources = true;
  const repository = h.f.stores.knowledge, receipt = repository.receipt.bind(repository), get = repository.get.bind(repository);
  const forwarding: KnowledgeRepository = { get, receipt, commit: repository.commit.bind(repository), indexHead: repository.indexHead.bind(repository),
    candidates: repository.candidates.bind(repository), rebuildIndex: repository.rebuildIndex.bind(repository), markIndexError: repository.markIndexError.bind(repository), close: async () => {} };
  const unstable = await h.makeRoot({ ...forwarding, receipt: async (...args) => { const result = await receipt(...args); h.access.actor.allowedNamespaces = []; return result; } }).forPersonal(actor);
  await assert.rejects(unstable.revisePersonalStatus(h.correction), /knowledge_unavailable/);
  h.access.actor.allowedNamespaces = ['personal'];
  const invalidRevision = await h.makeRoot({ ...forwarding, receipt: async (...args) => { const result = await receipt(...args); return result && { ...result, revision: 99 }; } }).forPersonal(actor);
  await assert.rejects(invalidRevision.revisePersonalStatus(h.correction), /knowledge_unavailable/);
  const foreignRecord = await h.makeRoot({ ...forwarding, get: async (...args) => { const result = await get(...args); return result && { ...result, tenantId: 'other-tenant' }; } }).forPersonal(actor);
  await assert.rejects(foreignRecord.revisePersonalStatus(h.correction));
});

test('document event-only correction recovers its witness through status without another source intake or commit', async t => {
  const h = await fixture(t, 'documents'); await h.memory.revisePersonal(h.correction);
  const documents = join(h.base, 'agent', 'memory', 'documents');
  const ns = readdirSync(documents).filter(name => /^ns-[a-f0-9]{64}$/.test(name)); assert.equal(ns.length, 1);
  const namespace = join(documents, ns[0]!);
  const events = () => readdirSync(namespace).filter(name => /^\d{8}\.md$/.test(name)).sort().map(name => ({ name, bytes: readFileSync(join(namespace, name)) }));
  const priorEvents = events(); assert.equal(priorEvents.length, 2);
  const witnessDirs = readdirSync(documents).filter(name => /^witness-[a-f0-9]{64}$/.test(name)); assert.equal(witnessDirs.length, 1);
  const witnessDirectory = join(documents, witnessDirs[0]!);
  const witnessNames = readdirSync(witnessDirectory).filter(name => /^\d{8}\.json$/.test(name)).sort(); assert.equal(witnessNames.length, 2);
  const witnessPath = join(witnessDirectory, witnessNames.at(-1)!), witnessBytes = readFileSync(witnessPath);
  const priorState = await h.f.runtime.state(h.accepted.workId), priorSession = await h.f.stores.sessions.get(h.session.scope);
  await h.close(); unlinkSync(witnessPath); await h.reopen(); assert.equal(existsSync(witnessPath), false);
  h.access.forbidSources = true; const commits = h.access.commits;
  assert.deepEqual(await h.memory.revisePersonalStatus(h.correction), { id: 'format', revision: 2, currentRevision: 2, currentStatus: 'active' });
  assert.deepEqual(readFileSync(witnessPath), witnessBytes); assert.deepEqual(events(), priorEvents);
  assert.equal(h.access.commits, commits); assert.deepEqual(await h.f.runtime.state(h.accepted.workId), priorState);
  assert.deepEqual(await h.f.stores.sessions.get(h.session.scope), priorSession);
});
