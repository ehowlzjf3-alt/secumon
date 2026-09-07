import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeService } from '../application/knowledge-service.js';
import { SessionKnowledgeSources } from '../application/session-knowledge-sources.js';
import type { KnowledgeRepository } from '../application/knowledge-ports.js';
import type { TrustedKnowledgeActor } from '../domain/knowledge.js';
import { registerDocumentKnowledgeStore } from '../infrastructure/document-knowledge-owner.js';
import { FileBoundaryFault, hostMetadataFiles } from '../infrastructure/host-metadata-files.js';
import { actor, initialize, open, request, scenario } from './session-flow-helpers.js';

const quote = '문서 정본의 기억은 출처를 확인한 뒤 한국어로 설명한다.';
function baseFixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'document-memory-recovery-')));
  mkdirSync(join(base, 'engine'), { mode: 0o700 }); initialize(base, 'sqlite', 'agent', 'documents');
  return base;
}
function observe(repository: KnowledgeRepository, calls: string[]): KnowledgeRepository {
  return {
    get: async (...args) => { calls.push('get'); return repository.get(...args); },
    receipt: async (...args) => { calls.push('receipt'); return repository.receipt(...args); },
    commit: async command => { calls.push('commit'); return repository.commit(command); },
    indexHead: repository.indexHead.bind(repository), candidates: repository.candidates.bind(repository),
    rebuildIndex: repository.rebuildIndex.bind(repository), markIndexError: repository.markIndexError.bind(repository), close: async () => {},
  };
}
async function serviceFixture(t: TestContext) {
  const base = baseFixture(); let f = await open(base); const calls: string[] = [];
  t.after(async () => { try { await f.close(); } finally { rmSync(base, { recursive: true, force: true }); } });
  const session = await f.sessions!.open(actor, { channel: 'test', conversationId: 'document-original' });
  const accepted = await f.sessions!.accept(actor, { sessionId: session.scope.sessionId, rawText: quote, request: request('original') });
  const trusted: TrustedKnowledgeActor = { ...actor, agentId: f.stores.profile.identity.agentId, allowedNamespaces: ['personal'],
    allowedLabels: scenario.policy.allowedLabels, allowedDestinations: scenario.policy.allowedDestinations, allowedScopes: [scenario.goal.scope], canPublish: false, canReview: false };
  const create = () => new KnowledgeService({ repository: observe(f.stores.knowledge, calls), states: f.stores.state,
    clock: f.services.clock, digester: f.services.digester, actors: { current: async () => structuredClone(trusted) },
    userSources: new SessionKnowledgeSources(f.services, f.stores.sessions, f.stores.profile.identity.agentId) }).forPersonal(actor);
  let memory = await create();
  const remember = { id: 'format', commandId: 'remember', title: '문서 기억', source: { sessionId: session.scope.sessionId, messageId: 'original', quote } };
  return { base, calls, session, accepted, remember, documents: join(base, 'agent', 'memory', 'documents'),
    get memory() { return memory; }, get f() { return f; },
    async close() { await f.close(); },
    async reopen() { f = await open(base); memory = await create(); calls.length = 0; },
  };
}
function canonicalEvents(documents: string) {
  const namespaces = readdirSync(documents).filter(name => /^ns-[a-f0-9]{64}$/.test(name));
  assert.equal(namespaces.length, 1);
  const directory = join(documents, namespaces[0]!);
  return readdirSync(directory).filter(name => /^\d{8}\.md$/.test(name)).sort().map(name => ({ name, bytes: readFileSync(join(directory, name)) }));
}
function removeLastWitness(documents: string) {
  const witnesses = readdirSync(documents).filter(name => /^witness-[a-f0-9]{64}$/.test(name));
  assert.equal(witnesses.length, 1);
  const directory = join(documents, witnesses[0]!);
  const names = readdirSync(directory).filter(name => /^\d{8}\.json$/.test(name)).sort();
  assert.equal(names.length, canonicalEvents(documents).length);
  const path = join(directory, names.at(-1)!), bytes = readFileSync(path);
  unlinkSync(path); return { path, bytes };
}

test('remember duplicate repairs an event-only suffix through receipt-first reads without another canonical commit', async t => {
  const h = await serviceFixture(t), original = await h.memory.remember(h.remember);
  const before = await h.f.runtime.state(h.accepted.workId), events = canonicalEvents(h.documents);
  await h.close(); const witness = removeLastWitness(h.documents);
  await h.reopen(); assert.equal(existsSync(witness.path), false);
  const repeated = await h.memory.remember(h.remember);
  assert.equal(h.calls[0], 'receipt'); assert.ok(h.calls.includes('get')); assert.equal(h.calls.includes('commit'), false);
  assert.deepEqual(repeated.card, original.card); assert.deepEqual(readFileSync(witness.path), witness.bytes);
  assert.deepEqual(canonicalEvents(h.documents), events);
  assert.equal((await h.f.stores.sessions.input(h.session.scope, 'original'))!.text, quote);
  const after = await h.f.runtime.state(h.accepted.workId);
  assert.deepEqual(after.budget, before.budget); assert.deepEqual(after.modelCalls, before.modelCalls);
});

test('forget duplicate repairs its event-only suffix through get-first reads and leaves the memory deleted', async t => {
  const h = await serviceFixture(t); await h.memory.remember(h.remember);
  const command = { id: 'format', expectedRevision: 1, commandId: 'forget', reason: '사용자가 기억 사용을 중단함' };
  assert.deepEqual(await h.memory.forgetPersonal(command), { id: 'format', revision: 2 });
  const before = await h.f.runtime.state(h.accepted.workId), events = canonicalEvents(h.documents);
  await h.close(); const witness = removeLastWitness(h.documents);
  await h.reopen(); assert.equal(existsSync(witness.path), false);
  assert.deepEqual(await h.memory.forgetPersonal(command), { id: 'format', revision: 2 });
  assert.deepEqual(h.calls.slice(0, 2), ['get', 'receipt']); assert.equal(h.calls.includes('commit'), false);
  assert.deepEqual(readFileSync(witness.path), witness.bytes); assert.deepEqual(canonicalEvents(h.documents), events);
  await assert.rejects(h.memory.get('format'), /knowledge_unavailable/);
  assert.deepEqual((await h.memory.search({ namespace: 'personal', scope: 'personal', text: '', limit: 5 })).cards, []);
  await assert.rejects(h.memory.remember(h.remember), /knowledge_unavailable/);
  assert.equal((await h.f.stores.sessions.input(h.session.scope, 'original'))!.text, quote);
  const after = await h.f.runtime.state(h.accepted.workId);
  assert.deepEqual(after.budget, before.budget); assert.deepEqual(after.modelCalls, before.modelCalls);
});

async function pendingRegistration(t: TestContext) {
  const base = baseFixture(); t.after(() => rmSync(base, { recursive: true, force: true }));
  const f = await open(base), profile = f.stores.profile;
  await f.close();
  const documents = join(profile.root, 'memory', 'documents'), ownerPath = join(documents, 'owner.json');
  const ownerBytes = readFileSync(ownerPath), pendingPath = join(documents, `.secumon-init-${randomUUID()}.pending`);
  renameSync(ownerPath, pendingPath); unlinkSync(join(documents, 'format.json'));
  unlinkSync(join(profile.paths.metadata, 'document-memory-ready.json'));
  const assignmentPath = join(profile.paths.metadata, 'personal-memory-profile.json'), assignment = readFileSync(assignmentPath);
  return { base, profile, documents, ownerPath, ownerBytes, pendingPath, assignmentPath, assignment };
}

test('C01 resumes an assigned owner-pending-only registration using a new owner publication and preserves the prior candidate', async t => {
  const h = await pendingRegistration(t), resumed = await open(h.base);
  try {
    assert.equal(resumed.stores.profile.identity.agentId, h.profile.identity.agentId);
    assert.deepEqual(resumed.stores.profile.config, h.profile.config);
    assert.deepEqual(readFileSync(h.ownerPath), h.ownerBytes);
    assert.deepEqual(readFileSync(h.pendingPath), h.ownerBytes, 'an old candidate is preserved, not adopted or removed');
    assert.deepEqual(readFileSync(h.assignmentPath), h.assignment);
    assert.equal(existsSync(join(h.documents, 'format.json')), true);
    assert.equal(existsSync(join(h.profile.paths.metadata, 'document-memory-ready.json')), true);
  } finally { await resumed.close(); }
});

for (const damage of ['partial', 'foreign-owner'] as const) {
  test(`C01 refuses ${damage} pending-only registration and preserves its unconfirmed bytes`, async t => {
    const h = await pendingRegistration(t);
    const damaged = damage === 'partial' ? Buffer.from('{"schemaVersion":1') :
      Buffer.from(JSON.stringify({ ...JSON.parse(h.ownerBytes.toString('utf8')), agentId: randomUUID() }));
    writeFileSync(h.pendingPath, damaged);
    await assert.rejects(open(h.base), /document_knowledge_registration_cleanup_required/);
    assert.deepEqual(readFileSync(h.pendingPath), damaged); assert.deepEqual(readFileSync(h.assignmentPath), h.assignment);
    assert.equal(existsSync(h.ownerPath), false);
    assert.equal(existsSync(join(h.profile.paths.metadata, 'document-memory-ready.json')), false);
  });
}

test('registration re-enumerates a disappeared owned pending file without rewriting owner or format', async t => {
  const base = baseFixture(); t.after(() => rmSync(base, { recursive: true, force: true }));
  const f = await open(base), profile = f.stores.profile;
  await f.close();
  const config = profile.config; assert.ok(config.schemaVersion === 2);
  const documents = join(profile.root, 'memory', 'documents');
  const ownerPath = join(documents, 'owner.json'), formatPath = join(documents, 'format.json');
  const ownerBytes = readFileSync(ownerPath), formatBytes = readFileSync(formatPath);
  const pendingLeaf = `.secumon-init-${randomUUID()}.pending`, pendingPath = join(documents, pendingLeaf);
  writeFileSync(pendingPath, ownerBytes, { flag: 'wx', mode: 0o600 });
  const files = hostMetadataFiles(), original = files.readStableRegularFile;
  const own = Object.getOwnPropertyDescriptor(files, 'readStableRegularFile');
  let removed = 0, missing: unknown;
  files.readStableRegularFile = function (...args: Parameters<typeof original>) {
    if (args[1] === pendingLeaf && removed === 0) {
      unlinkSync(pendingPath); removed++;
      try { return original.apply(this, args); }
      catch (error) { missing = error; throw error; }
    }
    return original.apply(this, args);
  };
  try {
    registerDocumentKnowledgeStore(documents, { root: profile.root, agentId: profile.identity.agentId,
      storeId: config.storage.personalMemory.storeId });
    assert.equal(removed, 1);
    assert.ok(missing instanceof FileBoundaryFault);
    assert.equal(missing.code, 'missing'); assert.equal(missing.operation, 'open');
    assert.equal((missing.cause as NodeJS.ErrnoException).code, 'ENOENT');
    assert.equal(existsSync(pendingPath), false);
    assert.deepEqual(readFileSync(ownerPath), ownerBytes);
    assert.deepEqual(readFileSync(formatPath), formatBytes);
  } finally {
    if (own) Object.defineProperty(files, 'readStableRegularFile', own);
    else Reflect.deleteProperty(files, 'readStableRegularFile');
  }
});
