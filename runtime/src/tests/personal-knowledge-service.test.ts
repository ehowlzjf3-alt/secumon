import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeService } from '../application/knowledge-service.js';
import { SessionKnowledgeSources } from '../application/session-knowledge-sources.js';
import { transact } from '../application/work-transactions.js';
import { quarantineKnowledge } from '../application/data-lifecycle.js';
import { createKnowledgeTools, KNOWLEDGE_TOOL_IDS } from '../application/knowledge-tools.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { ToolResultSchema } from '../application/contracts.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import type { KnowledgeRepository } from '../application/knowledge-ports.js';
import type { TrustedKnowledgeActor } from '../domain/knowledge.js';
import type { TaskSpec, WorkState } from '../domain/model.js';
import { actor, initialize, open, request, scenario } from './session-flow-helpers.js';

const firstQuote = '답변은 한국어로 작성하고 먼저 세 문장으로 요약해 주세요.';
const nextQuote = '한국어로 요약한 뒤 자세한 설명과 근거도 붙여 주세요.';
const query = { namespace: 'personal', scope: 'personal', text: '', limit: 5 };

async function fixture(t: TestContext, backend: 'sqlite' | 'file-journal' = 'sqlite', personalMemory: 'sqlite' | 'documents' = 'sqlite') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'personal-memory-service-')));
  mkdirSync(join(base, 'engine'), { mode: 0o700 }); initialize(base, backend, 'agent', personalMemory);
  let f = await open(base);
  const session = await f.sessions!.open(actor, { channel: 'test', conversationId: 'personal-source' });
  const accepted = await f.sessions!.accept(actor, { sessionId: session.scope.sessionId, rawText: firstQuote, request: request('first') });
  const access: { actor: TrustedKnowledgeActor } = { actor: { ...actor, agentId: f.stores.profile.identity.agentId,
    allowedLabels: [...scenario.policy.allowedLabels], allowedDestinations: [...scenario.policy.allowedDestinations], allowedScopes: [scenario.goal.scope],
    allowedNamespaces: ['local', 'personal'], canReview: true, canPublish: true } };
  const makeRoot = (repository: KnowledgeRepository = f.stores.knowledge) => new KnowledgeService({
    repository, states: f.stores.state, clock: f.services.clock, digester: f.services.digester,
    actors: { current: async () => structuredClone(access.actor) },
    userSources: new SessionKnowledgeSources(f.services, f.stores.sessions, f.stores.profile.identity.agentId),
  });
  let root = makeRoot(), memory = await root.forPersonal(actor);
  t.after(async () => { await f.close(); rmSync(base, { recursive: true, force: true }); });
  const remember = { id: 'format', commandId: 'remember-format', title: '답변 형식', source: { sessionId: session.scope.sessionId, messageId: 'first', quote: firstQuote } };
  let changes = 0;
  return { base, session, accepted, access, remember, makeRoot,
    get f() { return f; }, get root() { return root; }, get memory() { return memory; },
    async reopen() { await f.close(); f = await open(base); root = makeRoot(); memory = await root.forPersonal(actor); },
    async input(text = nextQuote, messageId = 'next') {
      await f.sessions!.input(actor, { sessionId: session.scope.sessionId, workId: accepted.workId, messageId, rawText: text, expectedGoalRevision: 1 });
      return { sessionId: session.scope.sessionId, messageId, quote: text };
    },
    async mutate(change: (state: WorkState) => void) {
      return transact(f.services, accepted.workId, `personal-source-change-${++changes}`, 'personal_source_test_change', {}, change);
    },
  };
}

for (const backend of ['sqlite', 'file-journal'] as const) {
  test(`personal memory reuses applied original and survives restart without copying conversation (${backend})`, async t => {
    const h = await fixture(t, backend);
    assert.deepEqual((await h.memory.search(query)).cards, []);
    const before = await h.f.runtime.state(h.accepted.workId);
    const read = await h.memory.remember(h.remember);
    assert.equal(read.card.body, firstQuote); assert.equal(read.card.kind, 'personal'); assert.equal(read.card.coverage, 'unknown');
    assert.equal(read.dependency.sources[0]!.type, 'session_user_receipt');
    assert.equal('evidenceId' in read.dependency.sources[0]!, false);
    assert.equal(await h.memory.validateDependencies([read.dependency]), true);
    assert.equal(await h.root.validateDependencies([read.dependency]), true);
    const after = await h.f.runtime.state(h.accepted.workId);
    assert.deepEqual(after.evidence, before.evidence); assert.deepEqual(after.budget, before.budget); assert.deepEqual(after.modelCalls, []);
    assert.deepEqual((await h.memory.search({ ...query, text: '한국어' })).cards.map(card => card.id), ['format']);
    assert.equal((await h.memory.search(query)).index.status, 'ready');
    await h.reopen();
    assert.equal((await h.memory.get('format')).card.body, firstQuote);
    assert.equal((await h.f.stores.sessions.input(h.session.scope, 'first'))!.text, firstQuote);
    assert.deepEqual((await h.memory.remember(h.remember)).card, read.card);
  });
}

test('personal correction uses a new applied original and invalidates the old dependency', async t => {
  const h = await fixture(t), original = await h.memory.remember(h.remember), source = await h.input();
  const correction = { id: 'format', commandId: 'correct', expectedRevision: 1, title: '새 답변 형식', source, reason: '사용자 정정' };
  assert.deepEqual(await h.memory.revisePersonal(correction), { id: 'format', revision: 2 });
  assert.deepEqual(await h.memory.revisePersonal(correction), { id: 'format', revision: 2 });
  assert.equal(await h.memory.validateDependencies([original.dependency]), false);
  const current = await h.memory.get('format'); assert.equal(current.card.body, nextQuote); assert.equal(current.card.contentRevision, 2);
  assert.equal(current.dependency.sources[0]!.sourceVersion === original.dependency.sources[0]!.sourceVersion, false);
  assert.deepEqual((await h.memory.search({ ...query, text: '세 문장' })).cards, []);
  await assert.rejects(h.memory.revisePersonal({ ...correction, commandId: 'stale-correct' }), /knowledge_revision_conflict/);
  await assert.rejects(h.memory.revise({ id: 'format', commandId: 'unproven', expectedRevision: 2, title: '허위', body: '원문 없음', reason: 'no source' }), /knowledge_unavailable/);
});

test('forget removes active body and quote, preserves originals and never revives an old create', async t => {
  const h = await fixture(t), original = await h.memory.remember(h.remember);
  const command = { id: 'format', commandId: 'forget', expectedRevision: 1, reason: '사용자 잊기' };
  assert.deepEqual(await h.memory.forgetPersonal(command), { id: 'format', revision: 2 });
  assert.deepEqual(await h.memory.forgetPersonal(command), { id: 'format', revision: 2 });
  assert.equal(await h.memory.validateDependencies([original.dependency]), false);
  await h.reopen(); await assert.rejects(h.memory.get('format'), /knowledge_unavailable/);
  assert.deepEqual((await h.memory.search(query)).cards, []);
  await assert.rejects(h.memory.remember(h.remember), /knowledge_unavailable/);
  const record = await h.f.stores.knowledge.get(actor.tenantId, 'format', { partition: 'personal', agentId: h.access.actor.agentId!, principalId: actor.principalId });
  assert(record); assert.equal(record.status, 'deleted'); assert.equal(record.body, '');
  const source = record.sources[0]!; assert.equal(source.type, 'session_user_receipt');
  if (source.type === 'session_user_receipt') assert.equal(source.quote, '');
  assert.equal((await h.f.stores.sessions.input(h.session.scope, 'first'))!.text, firstQuote);
});

test('personal source never becomes shareable Evidence or a derived work-knowledge fact', async t => {
  const h = await fixture(t); await h.memory.remember(h.remember);
  const command = { id: 'format', commandId: 'share', expectedRevision: 1, reason: 'share attempt' };
  await assert.rejects(h.memory.submitForReview(command), /knowledge_unavailable/);
  await assert.rejects(h.memory.reviewAndPromote({ ...command, expectedContentRevision: 1 }), /knowledge_unavailable/);
  await assert.rejects(h.root.get('format'), /knowledge_unavailable/);
  await assert.rejects(h.root.create({ id: 'fake-fact', commandId: 'derive', namespace: 'local', scope: scenario.goal.scope,
    kind: 'fact', title: 'Fake verified fact', body: firstQuote, labels: [], sources: [], derivedFrom: ['format'], expiresAt: null }), /knowledge_unavailable/);
});

for (const mutation of ['labels', 'scope', 'destination', 'principal', 'tenant', 'generation'] as const) {
  test(`current user-source ${mutation} prevents cached read and dependency reuse`, async t => {
    const h = await fixture(t), original = await h.memory.remember(h.remember);
    assert.equal((await h.memory.search(query)).cards.length, 1);
    await h.mutate(state => {
      if (mutation === 'labels') state.policy.allowedLabels = [];
      if (mutation === 'scope') state.goal.scope = 'other-scope';
      if (mutation === 'destination') state.policy.allowedDestinations = [];
      if (mutation === 'principal') state.policy.principalId = 'other-user';
      if (mutation === 'tenant') state.policy.tenantId = 'other-tenant';
      if (mutation === 'generation') state.dataLifecycle = { generation: 1, blockedArtifactIds: [], changes: [] };
    });
    await assert.rejects(h.memory.get('format'));
    assert.equal(await h.memory.validateDependencies([original.dependency]), false);
    await h.memory.forgetPersonal({ id: 'format', expectedRevision: 1, commandId: 'forget-invalid-source', reason: '원문을 사용할 수 없어도 잊기' });
    assert.deepEqual((await h.memory.search(query)).cards, []);
  });
}

test('host caller restrictions reach the actual reader and do not prevent authorized forgetting', async t => {
  const h = await fixture(t); await h.memory.remember(h.remember);
  const narrowed = await h.root.forPersonal({ ...actor, allowedLabels: [], allowedDestinations: ['local'] });
  await assert.rejects(narrowed.get('format'), /knowledge_unavailable/);
  assert.deepEqual((await narrowed.search(query)).cards, []);
  await narrowed.forgetPersonal({ id: 'format', expectedRevision: 1, commandId: 'forget-restricted', reason: '사용자 삭제' });
  await assert.rejects(h.root.forPersonal({ ...actor, principalId: 'other' }), /knowledge_unavailable/);
});

test('reviewer grants cannot expose another user personal record or command receipt', async t => {
  const h = await fixture(t); await h.memory.remember(h.remember);
  const retainedService = h.memory;
  h.access.actor.principalId = 'other-user';
  await assert.rejects(retainedService.get('format'), /knowledge_unavailable/);
  const other = await h.root.forPersonal();
  await assert.rejects(other.get('format'), /knowledge_unavailable/); assert.deepEqual((await other.search(query)).cards, []);
  await assert.rejects(other.forgetPersonal({ id: 'format', commandId: 'remember-format', expectedRevision: 1, reason: 'foreign' }), /knowledge_unavailable/);
});

for (const mutation of ['history', 'receipt-digest', 'pending', 'rejected', 'missing'] as const) {
  test(`personal original ${mutation} boundary is checked against actual stored intake`, async t => {
    const h = await fixture(t), input = h.f.stores.sessions.input.bind(h.f.stores.sessions), history = h.f.stores.sessions.history.bind(h.f.stores.sessions);
    if (mutation === 'history') h.f.stores.sessions.history = async (...args) => {
      const page = await history(...args); return { ...page, entries: page.entries.map(entry => ({ ...entry, text: entry.text + ' altered' })) };
    };
    else h.f.stores.sessions.input = async (...args) => {
      const receipt = await input(...args); if (!receipt) return receipt;
      if (mutation === 'missing') return null;
      if (mutation === 'receipt-digest') return { ...receipt, digest: '0'.repeat(64) };
      return { ...receipt, status: mutation };
    };
    try { await assert.rejects(h.memory.remember(h.remember)); }
    finally { h.f.stores.sessions.input = input; h.f.stores.sessions.history = history; }
    assert.equal((await input(h.session.scope, 'first'))!.text, firstQuote);
    assert.deepEqual((await h.memory.search(query)).cards, []);
  });
}

test('fabricated or assistant text cannot be an explicit user-memory source', async t => {
  const h = await fixture(t);
  await assert.rejects(h.memory.remember({ ...h.remember, source: { ...h.remember.source, quote: '원문에 없는 문장' } }), /knowledge_unavailable/);
  await assert.rejects(h.memory.remember({ ...h.remember, source: { ...h.remember.source, messageId: 'assistant-result' } }), /knowledge_unavailable/);
  assert.deepEqual((await h.memory.search(query)).cards, []);
});

test('commit response loss resumes from scoped receipt with one personal revision', async t => {
  const h = await fixture(t), commit = h.f.stores.knowledge.commit.bind(h.f.stores.knowledge); let lost = false;
  h.f.stores.knowledge.commit = async command => {
    const result = await commit(command);
    if (!lost && command.scope?.partition === 'personal') { lost = true; throw new Error('simulated_reply_loss_after_commit'); }
    return result;
  };
  await assert.rejects(h.memory.remember(h.remember), /simulated_reply_loss_after_commit/);
  const retry = await h.memory.remember(h.remember); assert.equal(retry.card.revision, 1);
  assert.equal((await h.memory.search(query)).cards.length, 1);
  await assert.rejects(h.memory.remember({ ...h.remember, title: 'same command changed' }), /knowledge_command_conflict/);
});

test('user-source inspection does not inherit unrelated model inputs or form a work-memory cycle', async t => {
  const h = await fixture(t); let inheritedInputChecks = 0;
  const root = new KnowledgeService({ repository: h.f.stores.knowledge, states: h.f.stores.state, clock: h.f.services.clock,
    digester: h.f.services.digester, actors: { current: async () => structuredClone(h.access.actor) },
    userSources: new SessionKnowledgeSources(h.f.services, h.f.stores.sessions, h.access.actor.agentId!),
    inputs: { current: async () => { inheritedInputChecks++; return false; }, validate: async () => false } });
  const memory = await root.forPersonal(), read = await memory.remember(h.remember);
  const inspected = await root.inspectDependencies([read.dependency]);
  assert.deepEqual(inspected.sourceWorkIds, []); assert.equal(await inspected.current(), true); assert.equal(inheritedInputChecks, 0);
  await h.mutate(state => { state.policy.allowedDestinations = []; });
  assert.equal(await inspected.current(), false);
});

test('recorded derived-copy quarantine does not revoke the new user correction it will consume', async t => {
  const h = await fixture(t); await h.memory.remember(h.remember);
  const source = await h.input();
  await h.memory.revisePersonal({ id: 'format', commandId: 'correct-before-reselect', expectedRevision: 1, title: '정정 형식', source, reason: '사용자 정정' });
  const revised = await h.memory.get('format');
  await h.mutate(state => { quarantineKnowledge(state, h.f.services.clock.now()); });
  assert.equal((await h.f.runtime.state(h.accepted.workId)).dataLifecycle!.generation, 1);
  assert.equal((await h.memory.get('format')).card.body, nextQuote);
  assert.equal(await h.memory.validateDependencies([revised.dependency]), true);
  await h.mutate(state => { state.dataLifecycle!.generation++; });
  assert.equal(await h.memory.validateDependencies([revised.dependency]), false);
});

for (const personalMemory of ['sqlite', 'documents'] as const) test(`${personalMemory}: actual memory tools recall personal cards across work scopes without accepting caller ownership`, async t => {
  const h = await fixture(t, 'sqlite', personalMemory); await h.memory.remember(h.remember);
  const secondSession = await h.f.sessions!.open(actor, { channel: 'test', conversationId: 'personal-consumer' });
  const accepted = await h.f.sessions!.accept(actor, { sessionId: secondSession.scope.sessionId, rawText: '다음 업무를 시작합니다.', request: request('consumer') });
  await transact(h.f.services, accepted.workId, 'consumer-scope', 'personal_tool_test_setup', {}, state => {
    state.goal.scope = 'new-work-scope'; state.policy.allowedTools = [...KNOWLEDGE_TOOL_IDS];
  });
  const state = await h.f.runtime.state(accepted.workId);
  const wrapper = createKnowledgeTools({ states: h.f.stores.state, repository: h.f.stores.knowledge,
    actors: { current: async () => structuredClone(h.access.actor) }, clock: h.f.services.clock, digester: h.f.services.digester,
    userSources: new SessionKnowledgeSources(h.f.services, h.f.stores.sessions, h.access.actor.agentId!) });
  const contracts = new ToolContracts(wrapper.tools, new AjvSchemas()); let attempt = 0;
  const invoke = (toolId: typeof KNOWLEDGE_TOOL_IDS[number], input: TaskSpec['input']) => wrapper.tools.find(tool => tool.definition.id === toolId)!.execute({
    id: `personal-tool-${++attempt}`, description: 'Read personal memory', toolId, toolVersion: '1', effect: 'read', input,
    maxAttempts: 1, dependsOn: [], satisfies: [],
  }, { workId: accepted.workId, attemptId: `personal-attempt-${attempt}`, policy: state.policy, signal: new AbortController().signal });
  const input = { memory: 'personal', id: 'format', maxBytes: 4096 };
  assert.equal(contracts.get('core.memory.get', '1')!.input(input), true);
  assert.equal(contracts.get('core.memory.get', '1')!.input({ ...input, principalId: 'other' }), false);
  const result = await invoke('core.memory.get', input); ToolResultSchema.parse(result);
  assert.equal(result.status, 'success'); assert.deepEqual(result.evidence, []); assert.equal(result.effectState, 'none');
  assert.equal((result.output as { card: { body: string } }).card.body, firstQuote);
  assert.equal(result.knowledgeDependencies![0]!.owner!.principalId, actor.principalId);
  assert.equal(await wrapper.validate(result.knowledgeDependencies!, accepted.workId, state.policy), true);
  assert.equal((await invoke('core.memory.get', { id: 'format', maxBytes: 4096 })).status, 'error');
  assert.equal((await invoke('core.memory.get', { ...input, agentId: 'other' })).status, 'error');
  const found = await invoke('core.memory.search', { memory: 'personal', namespace: 'personal', query: '한국어', limit: 5, maxBytes: 4096 });
  ToolResultSchema.parse(found); assert.equal(found.status, 'success');
  assert.deepEqual((found.output as { cards: { id: string }[] }).cards.map(card => card.id), ['format']);
  const bounded = await invoke('core.memory.get', { ...input, maxBytes: 256 });
  assert.equal(bounded.status, 'partial'); assert.equal((bounded.output as { status: string }).status, 'too_large');
  assert.equal(JSON.stringify(bounded.output).includes(firstQuote), false);
  await h.memory.forgetPersonal({ id: 'format', expectedRevision: 1, commandId: 'forget-tool-source', reason: '사용자 잊기' });
  assert.equal(await wrapper.validate(result.knowledgeDependencies!, accepted.workId, state.policy), false);
  assert.equal((await invoke('core.memory.get', input)).status, 'error');
});
