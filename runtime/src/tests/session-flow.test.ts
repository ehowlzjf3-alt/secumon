import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { actor, request, initialize, open, finish } from './session-flow-helpers.js';
import { asJson } from '../application/plan-validator.js';
import type { SessionRepository } from '../application/session-ports.js';

function directory() { const base = realpathSync(mkdtempSync(join(tmpdir(), 'session-flow-'))); mkdirSync(join(base, 'engine'), { mode: 0o700 }); return base; }
for (const backend of ['sqlite', 'file-journal'] as const) test(`${backend}: completed X and restarted Y share raw conversation but not work/evidence/budget`, async () => {
  const base = directory(); initialize(base, backend); let f = await open(base);
  try {
    const session = await f.sessions!.open(actor, { channel: 'test', conversationId: 'conversation' });
    const first = await f.sessions!.accept(actor, { sessionId: session.scope.sessionId, rawText: '앞으로 답변은 한국어 세 문장으로 해줘.', request: request('X') });
    await finish(f, first.workId);
    assert.equal((await f.runtime.state(first.workId)).status, 'completed');
    const history = await f.sessions!.history(actor, session.scope.sessionId, request('X').policy, { limit: 100 });
    const result = history.entries.find(entry => entry.kind === 'result')!;
    assert.equal(result.role, 'assistant'); assert.match(result.text, /doc-current/);
    await f.close(); f = await open(base);
    const resumed = await f.sessions!.open(actor, { channel: 'test', conversationId: 'conversation' });
    assert.equal(resumed.scope.sessionId, session.scope.sessionId);
    const second = await f.sessions!.accept(actor, { sessionId: resumed.scope.sessionId, rawText: '같은 형식으로 다음 문서를 확인해줘.', request: request('Y') });
    assert.notEqual(first.workId, second.workId); assert.deepEqual(second.state.evidence, []); assert.equal(second.state.budget.used.toolCalls, 0);
    const compiled = await f.context.prepare(second.state, { callId: 'inspect-input', maxOutputTokens: 100, maxInputBytes: 1000000, maxInputTokens: 1000000 });
    assert.equal(compiled.packet.session!.basis.scope.sessionId, resumed.scope.sessionId);
    assert(compiled.packet.session!.entries.some(entry => entry.sourceId === 'X' && entry.text.includes('한국어 세 문장')));
    assert(compiled.packet.session!.entries.some(entry => entry.sourceId === result.sourceId && entry.text === result.text));
    const stored = JSON.parse(new TextDecoder().decode(await f.stores.artifacts.get(compiled.head.artifact, second.state.policy)));
    assert.deepEqual(stored.packet.session, compiled.packet.session);
    assert.deepEqual(compiled.packet.evidence, []); assert.equal(f.tool.invocations.length, 0);
  } finally { await f.close(); rmSync(base, { recursive: true, force: true }); }
});

test('same message retransmission recovers stable work; conflicting raw text is rejected before extra work', async () => {
  const base = directory(); initialize(base); const f = await open(base);
  try {
    const session = await f.sessions!.open(actor, { channel: 'test', conversationId: 'conversation' });
    const input = { sessionId: session.scope.sessionId, rawText: 'original user words', request: request('same') };
    const a = await f.sessions!.accept(actor, input); const b = await f.sessions!.accept(actor, input);
    assert.equal(a.workId, b.workId); assert.equal(b.accepted, false);
    await assert.rejects(f.sessions!.accept(actor, { ...input, rawText: 'changed user words' }), /conflict/);
    assert.equal((await f.stores.sessions.history(session.scope, input.request.policy, { limit: 100 })).entries.filter(entry => entry.role === 'user').length, 1);
  } finally { await f.close(); rmSync(base, { recursive: true, force: true }); }
});

test('input/work linkage recovers after a failure following the durable work commit', async () => {
  const base = directory(); initialize(base); const f = await open(base);
  try {
    const session = await f.sessions!.open(actor, { channel: 'test', conversationId: 'conversation' });
    const repository = f.stores.sessions; const original = repository.settle.bind(repository); let fail = true;
    repository.settle = async (...args: Parameters<SessionRepository['settle']>) => { if (fail) { fail = false; throw new Error('link_interrupted'); } return original(...args); };
    const input = { sessionId: session.scope.sessionId, rawText: 'resume my exact request', request: request('recover') };
    await assert.rejects(f.sessions!.accept(actor, input), /link_interrupted/);
    const pending = await repository.input(session.scope, 'recover'); assert.equal(pending!.status, 'pending');
    const originalWork = await f.runtime.state(pending!.workId); assert(originalWork);
    assert.equal(await f.sessions!.current(originalWork), false);
    const recovered = await f.sessions!.accept(actor, input);
    assert.equal(recovered.workId, originalWork.id); assert.equal((await repository.pending(session.scope, 1)).length, 0);
    assert.equal((await f.stores.state.events(originalWork.id, 0)).filter(event => event.type === 'request_accepted').length, 1);
  } finally { await f.close(); rmSync(base, { recursive: true, force: true }); }
});

test('agents/users/new sessions cannot access or inject another session even with a known session ID', async () => {
  const base = directory(); initialize(base); initialize(base, 'sqlite', 'other'); const f = await open(base); const other = await open(base, 'other');
  try {
    const session = await f.sessions!.open(actor, { channel: 'test', conversationId: 'conversation' });
    const first = await f.sessions!.accept(actor, { sessionId: session.scope.sessionId, rawText: 'private original', request: request('private') });
    for (const [service, user] of [[other.sessions!, actor], [f.sessions!, { ...actor, principalId: 'intruder' }]] as const) {
      await assert.rejects(service.open(user, { channel: 'test', conversationId: 'conversation', sessionId: session.scope.sessionId }), /session/);
    }
    const fresh = await f.sessions!.open(actor, { channel: 'test', conversationId: 'conversation', newSession: true });
    assert.notEqual(fresh.scope.sessionId, session.scope.sessionId);
    assert.deepEqual((await f.sessions!.history(actor, fresh.scope.sessionId, request('private').policy, { limit: 100 })).entries, []);
    await assert.rejects(f.sessions!.accept(actor, { sessionId: fresh.scope.sessionId, rawText: 'spoof', request: { ...request('spoof'), binding: { ...request('spoof').binding, session: session.scope } } }), /authorized/);
    const forged = structuredClone(first.state); forged.conversation!.session!.scope.agentId = 'forged';
    assert.equal(await f.sessions!.current(forged), false);
  } finally { await f.close(); await other.close(); rmSync(base, { recursive: true, force: true }); }
});

test('new applied text invalidates old context and requires review; a rejected command does not block the next input', async () => {
  const base = directory(); initialize(base); const f = await open(base);
  try {
    const session = await f.sessions!.open(actor, { channel: 'test', conversationId: 'conversation' });
    const first = await f.sessions!.accept(actor, { sessionId: session.scope.sessionId, rawText: 'first', request: request('first') });
    const old = await f.sessions!.context(first.state);
    await f.sessions!.input(actor, { sessionId: session.scope.sessionId, messageId: 'more', workId: first.workId, rawText: 'Use the latest document only.', expectedGoalRevision: 1 });
    const state = await f.runtime.state(first.workId);
    assert.equal(state.conversation!.sessionReviewRequired, true); assert(state.conversation!.session!.input.sequence > first.sequence); assert.equal(await f.sessions!.current(state, old!), false);
    const context = await f.sessions!.context(state); assert(context!.entries.some(entry => entry.text === 'Use the latest document only.'));
    await assert.rejects(f.sessions!.command(actor, { sessionId: session.scope.sessionId, messageId: 'stale', workId: first.workId, rawText: 'cancel', expectedGoalRevision: 9, command: { kind: 'cancel', reason: 'cancel' } }), /stale_user_command/);
    assert.equal((await f.stores.sessions.input(session.scope, 'stale'))!.status, 'rejected');
    await f.sessions!.input(actor, { sessionId: session.scope.sessionId, messageId: 'later', workId: first.workId, rawText: 'Additional valid instruction.', expectedGoalRevision: 1 });
    const latest = await f.sessions!.context(await f.runtime.state(first.workId));
    assert(!latest!.entries.some(entry => entry.sourceId === 'stale'));
    assert.equal(f.services.digester.digest(asJson(latest!.basis)), f.services.digester.digest(asJson((await f.runtime.state(first.workId)).conversation!.session!)));
  } finally { await f.close(); rmSync(base, { recursive: true, force: true }); }
});

test('Y can prepare before X without trapping X or regressing the active session head', async () => {
  const base = directory(); initialize(base); const f = await open(base);
  try {
    const session = await f.sessions!.open(actor, { channel: 'test', conversationId: 'conversation' });
    const x = await f.sessions!.accept(actor, { sessionId: session.scope.sessionId, rawText: 'X original', request: request('X') });
    const y = await f.sessions!.accept(actor, { sessionId: session.scope.sessionId, rawText: 'Y later original', request: request('Y') });
    const cy = await f.sessions!.context(y.state); const head = (await f.stores.sessions.get(session.scope)).head;
    const cx = await f.sessions!.context(x.state);
    assert(cx!.entries.some(entry => entry.sourceId === 'X')); assert(!cx!.entries.some(entry => entry.sourceId === 'Y'));
    assert.deepEqual((await f.stores.sessions.get(session.scope)).head, head);
    assert.equal(await f.sessions!.current(x.state, cx!), true); assert.equal(await f.sessions!.current(y.state, cy!), true);
    assert.equal(await f.stores.sessions.publishHead(session.scope, 0, { throughSequence: x.sequence, digest: 'a'.repeat(64), policyDigest: 'b'.repeat(64) }), null);
    assert.equal((await f.stores.sessions.get(session.scope)).lastSequence, y.sequence);
  } finally { await f.close(); rmSync(base, { recursive: true, force: true }); }
});

test('context capacity is explicit and preserves the received original for later compact', async () => {
  const base = directory(); initialize(base); const f = await open(base);
  try {
    const session = await f.sessions!.open(actor, { channel: 'test', conversationId: 'conversation' });
    const text = '가'.repeat(30000);
    const input = await f.sessions!.accept(actor, { sessionId: session.scope.sessionId, rawText: text, request: request('large') });
    await assert.rejects(f.sessions!.context(input.state), /session_context_capacity/);
    const original = await f.stores.sessions.input(session.scope, 'large'); assert.equal(original!.text, text); assert.equal(original!.status, 'applied');
  } finally { await f.close(); rmSync(base, { recursive: true, force: true }); }
});
