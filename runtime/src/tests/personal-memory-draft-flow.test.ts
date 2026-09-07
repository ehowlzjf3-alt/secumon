import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { applyMemoryDraft, createMemoryDraft, memoryDraftStatus, resumeMemoryDraft } from '../presentation/local-memory-drafts.js';
import { getPersonal, forgetPersonal, revisePersonal, recallPersonal } from '../presentation/local-personal-memory.js';
import { actor, draftFixture, editDraft, edited, original } from './helpers/personal-memory-draft-flow.js';
import { openAgentLocalProfile } from '../presentation/local-profile.js';

for (const backend of ['sqlite', 'file-journal'] as const) test(`draft flow ${backend}: editor rename applies one source and revision, invalidates selected memory and survives reopen`, async t => {
  const f = await draftFixture(t, backend), before = await f.profile.runtime.state(f.workId);
  await recallPersonal(f.profile, actor, f.workId, { requestId: 'select-old', expectedGoalRevision: before.goal.revision,
    expectedStateRevision: before.revision, refs: [{ id: 'writing-style', revision: 1 }] });
  editDraft(f.draft.path);
  const applied = await applyMemoryDraft(f.profile, actor, f.input);
  assert.equal(applied.stage, 'complete'); assert.equal(applied.sourceStatus, 'applied'); assert.equal(applied.appliedRevision, 2);
  assert.equal((await getPersonal(f.profile, actor, 'writing-style')).card.body, edited);
  const after = await f.profile.runtime.state(f.workId);
  assert.equal(after.attempts.length, 0); assert.equal(after.modelCalls.length, 0);
  assert.equal(await f.profile.personalMemories!.current(after), false);
  assert.equal((await f.history()).entries.filter(e => e.role === 'user').length, 2);
  assert.equal((await applyMemoryDraft(f.profile, actor, f.input)).appliedRevision, 2);
  await f.reopen();
  assert.equal((await resumeMemoryDraft(f.profile, actor, f.resume)).appliedRevision, 2);
  assert.equal((await f.history()).entries.filter(e => e.role === 'user').length, 2);
  assert.equal((await f.history()).entries.find(e => e.sourceId === 'draft-original')?.text, original);
  const current = await f.profile.runtime.state(f.workId);
  await recallPersonal(f.profile, actor, f.workId, { requestId: 'select-new', expectedGoalRevision: current.goal.revision,
    expectedStateRevision: current.revision, refs: [{ id: 'writing-style', revision: 2 }] });
  const selected = await f.profile.runtime.state(f.workId);
  const packet = await f.profile.context.prepare(selected, { callId: 'draft-context', maxOutputTokens: 1024, maxInputBytes: 65536, maxInputTokens: 100000 });
  assert.equal(packet.packet.personalMemory?.entries[0]?.body, edited);
});

test('draft no-change and read-only status create no new raw input or memory revision', async t => {
  const f = await draftFixture(t), state = await f.profile.runtime.state(f.workId);
  const result = await applyMemoryDraft(f.profile, actor, f.input);
  assert.equal(result.stage, 'unchanged'); assert.equal(result.appliedRevision, null); assert.equal(result.sourceStatus, 'not_received');
  assert.equal((await memoryDraftStatus(f.profile, { ...actor, allowWrites: false }, f.resume)).stage, 'unchanged');
  assert.deepEqual(await f.profile.runtime.state(f.workId), state);
  assert.equal((await f.history()).entries.filter(e => e.role === 'user').length, 1);
  assert.equal((await getPersonal(f.profile, actor, 'writing-style')).card.revision, 1);
});

test('draft past result remains revision two after a later revision and forget; resume ignores edited or missing draft', async t => {
  const f = await draftFixture(t); editDraft(f.draft.path);
  await applyMemoryDraft(f.profile, actor, f.input);
  await revisePersonal(f.profile, actor, { requestId: 'later-revision', id: 'writing-style', expectedRevision: 2, title: '다른 정정', reason: '다른 요청',
    source: { kind: 'existing', sessionId: f.session.scope.sessionId, messageId: 'draft-original', quote: original } });
  let status = await memoryDraftStatus(f.profile, actor, f.resume);
  assert.equal(status.appliedRevision, 2); assert.equal(status.currentRevision, 3);
  editDraft(f.draft.path, '다시 바꾼 제목', '아직 적용하지 않은 다음 편집');
  await assert.rejects(applyMemoryDraft(f.profile, actor, f.input), /draft_conflict/);
  unlinkSync(f.draft.path);
  assert.equal((await resumeMemoryDraft(f.profile, actor, f.resume)).appliedRevision, 2);
  await forgetPersonal(f.profile, actor, { requestId: 'forget-later', id: 'writing-style', expectedRevision: 3, reason: '개인 기억에서 잊기' });
  await f.reopen(); status = await resumeMemoryDraft(f.profile, actor, f.resume);
  assert.equal(status.stage, 'complete'); assert.equal(status.appliedRevision, 2); assert.equal(status.currentRevision, 4); assert.equal(status.currentStatus, 'deleted');
  await assert.rejects(getPersonal(f.profile, actor, 'writing-style'), /knowledge_unavailable/);
  assert.equal((await f.history()).entries.filter(e => e.role === 'user').length, 2);
});

test('draft stale target, read-only actor and other owner are refused before a source input is created', async t => {
  const f = await draftFixture(t); editDraft(f.draft.path);
  await assert.rejects(createMemoryDraft(f.profile, { ...actor, allowWrites: false }, { draftId: randomUUID(), memoryId: 'writing-style' }), /read_only/);
  await assert.rejects(applyMemoryDraft(f.profile, { ...actor, allowWrites: false }, f.input), /read_only/);
  await assert.rejects(applyMemoryDraft(f.profile, { ...actor, principalId: 'somebody-else' }, f.input));
  await assert.rejects(applyMemoryDraft(f.profile, actor, { ...f.input, expectedGoalRevision: f.input.expectedGoalRevision + 1 }), /stale_user_command/);
  await assert.rejects(applyMemoryDraft(f.profile, actor, { ...f.input, sessionId: 'different-session' }), /session_work_unavailable/);
  await revisePersonal(f.profile, actor, { requestId: 'before-draft', id: 'writing-style', expectedRevision: 1, title: '새 버전', reason: '별도 변경',
    source: { kind: 'existing', sessionId: f.session.scope.sessionId, messageId: 'draft-original', quote: original } });
  await assert.rejects(applyMemoryDraft(f.profile, actor, f.input), /knowledge_revision_conflict/);
  await assert.rejects(memoryDraftStatus(f.profile, actor, f.resume), /operation_missing/);
  assert.equal((await f.history()).entries.filter(e => e.role === 'user').length, 1);
});

test('draft source applied before a competing memory revision remains an explicit partial result', async t => {
  const f = await draftFixture(t); editDraft(f.draft.path);
  const originalInput = f.profile.sessions!.inputOnly.bind(f.profile.sessions!);
  f.profile.sessions!.inputOnly = async (...args) => {
    const result = await originalInput(...args);
    await revisePersonal(f.profile, actor, { requestId: 'competing', id: 'writing-style', expectedRevision: 1, title: '경합 정정', reason: '먼저 적용된 별도 정정',
      source: { kind: 'existing', sessionId: f.session.scope.sessionId, messageId: 'draft-original', quote: original } });
    return result;
  };
  await assert.rejects(applyMemoryDraft(f.profile, actor, f.input), /knowledge_revision_conflict/);
  f.profile.sessions!.inputOnly = originalInput;
  const status = await memoryDraftStatus(f.profile, actor, f.resume);
  assert.equal(status.stage, 'memory_pending'); assert.equal(status.sourceStatus, 'applied'); assert.equal(status.appliedRevision, null); assert.equal(status.currentRevision, 2);
  await assert.rejects(resumeMemoryDraft(f.profile, actor, f.resume), /knowledge_revision_conflict/);
  assert.equal((await f.history()).entries.filter(e => e.role === 'user').length, 2);
  assert.equal((await getPersonal(f.profile, actor, 'writing-style')).card.body, original);
});

test('a stale absent-operation observation joins the exact apply completed by another profile', async t => {
  const f = await draftFixture(t); editDraft(f.draft.path);
  const other = await openAgentLocalProfile(f.directory, {}, undefined, f.hostOptions);
  const originalOperation = f.profile.memoryDrafts!.store.operation.bind(f.profile.memoryDrafts!.store);
  let observed = false;
  f.profile.memoryDrafts!.store.operation = async (...args) => {
    const value = await originalOperation(...args);
    if (!observed && value === null) { observed = true; await applyMemoryDraft(other, actor, f.input); }
    return value;
  };
  try {
    const joined = await applyMemoryDraft(f.profile, actor, f.input);
    assert.equal(joined.appliedRevision, 2); assert(observed);
    assert.equal((await f.history()).entries.filter(e => e.role === 'user').length, 2);
  } finally { await other.close(); }
});

for (const phase of ['preflight', 'after-intent'] as const) test(`real source snapshot contention at ${phase} converges on the same apply receipt`, async t => {
  const f = await draftFixture(t); editDraft(f.draft.path);
  const other = await openAgentLocalProfile(f.directory, {}, undefined, f.hostOptions);
  const bind = f.profile.memoryDrafts!.store.bind.bind(f.profile.memoryDrafts!.store);
  const history = f.profile.sessions!.repository.history.bind(f.profile.sessions!.repository), knowledge = f.profile.personalKnowledge;
  let armed = phase === 'preflight', switched = false, contentions = 0;
  f.profile.memoryDrafts!.store.bind = async (...args) => { const value = await bind(...args); armed = true; return value; };
  f.profile.sessions!.repository.history = async (...args) => {
    const page = await history(...args);
    if (armed && !switched) { switched = true; await applyMemoryDraft(other, actor, f.input); }
    return page;
  };
  f.profile.personalKnowledge = async (...args) => {
    const service = await knowledge(...args), get = service.get.bind(service);
    service.get = async id => { try { return await get(id); } catch (error) { if (error instanceof Error && error.message === 'knowledge_contention') contentions++; throw error; } };
    return service;
  };
  try {
    const result = await applyMemoryDraft(f.profile, actor, f.input);
    assert(switched); assert(contentions > 0, 'actual source validation must observe the changed work basis'); assert.equal(result.appliedRevision, 2);
    assert.equal((await f.history()).entries.filter(entry => entry.role === 'user').length, 2);
    assert.equal((await getPersonal(f.profile, actor, 'writing-style')).card.revision, 2);
  } finally { await other.close(); }
});

test('contention reported after the real memory commit rechecks the original receipt without another revision', async t => {
  const f = await draftFixture(t); editDraft(f.draft.path);
  const knowledge = f.profile.personalKnowledge; let committed = 0;
  f.profile.personalKnowledge = async (...args) => {
    const service = await knowledge(...args), revise = service.revisePersonal.bind(service);
    service.revisePersonal = async input => {
      const result = await revise(input); committed++;
      if (committed === 1) throw new Error('knowledge_contention'); return result;
    };
    return service;
  };
  const result = await applyMemoryDraft(f.profile, actor, f.input);
  assert.equal(result.appliedRevision, 2); assert.equal(committed, 1);
  assert.equal((await f.history()).entries.filter(entry => entry.role === 'user').length, 2);
});

test('persistent knowledge contention is bounded and does not publish source input', async t => {
  const f = await draftFixture(t); editDraft(f.draft.path);
  const knowledge = f.profile.personalKnowledge; let reads = 0;
  f.profile.personalKnowledge = async (...args) => {
    const service = await knowledge(...args); service.get = async () => { reads++; throw new Error('knowledge_contention'); }; return service;
  };
  await assert.rejects(applyMemoryDraft(f.profile, actor, f.input), /knowledge_contention/);
  assert.equal(reads, 3); assert.equal((await f.history()).entries.filter(entry => entry.role === 'user').length, 1);
});
