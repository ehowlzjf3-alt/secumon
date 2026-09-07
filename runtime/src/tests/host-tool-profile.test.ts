import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Policy } from '../domain/model.js';
import { readGeneratedAnswer } from '../application/generated-answer.js';
import { ToolResultSchema } from '../application/contracts.js';
import { SqliteStateRepository } from '../infrastructure/sqlite-state.js';
import { SYNTHETIC_AGENT_TURN_REQUESTS as requests } from '../infrastructure/synthetic-agent-turn.js';
import { openAgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { acceptHostRequest, errorLeaves, hostLimits, hostPolicy, hostToolFixture, toolHost } from './host-tool-profile-helper.js';

test('one host gives SQLite and journal agents distinct sources without mixing sessions, results or lease ownership', { timeout: 60000 }, async t => {
  const f = hostToolFixture(t), h = toolHost(), a = f.create('sqlite-agent'), b = f.create('journal-agent', 'file-journal');
  h.days.set(a.identity.agentId, 17); h.days.set(b.identity.agentId, 83);
  const left = await f.open(a.root, h.host), right = await f.open(b.root, h.host);
  assert.equal(left.stateBackend, 'sqlite'); assert.equal(right.stateBackend, 'file-journal');
  assert.notEqual(left.agentId, right.agentId); assert.deepEqual(left.actor, right.actor);
  assert.deepEqual(left.policy, hostPolicy); assert.deepEqual(right.limits, hostLimits);
  assert.deepEqual(h.toolOpens, [a, b].map(value => ({ agentId: value.identity.agentId, root: value.root, scope: `agent:${value.identity.agentId}` })));
  assert.ok(h.modelOpens.every(value => Object.keys(value).sort().join(',') === 'agentId,purpose,skillsMode'));
  const x = await acceptHostRequest(left, 'same-message', requests.read), y = await acceptHostRequest(right, 'same-message', requests.read);
  assert.notEqual(x.workId, y.workId); assert.notEqual(x.sessionId, y.sessionId);
  for (const [profile, accepted, period] of [[left, x, 17], [right, y, 83]] as const) {
    assert.equal((await profile.workflow.run(accepted.workId, profile.actor)).control.kind, 'complete');
    const state = await profile.runtime.state(accepted.workId);
    assert.deepEqual(state.policy, hostPolicy); assert.equal(state.budget.used.toolCalls, 1); assert.equal(state.budget.used.modelCalls, 2);
    assert.equal(state.evidence.length, 1); assert.equal(state.evidence[0]!.scope, profile.scope);
    assert.equal(state.evidence[0]!.tenantId, hostPolicy.tenantId); assert.equal(state.evidence[0]!.facts['retention.days'], period);
    assert.equal(state.evidence[0]!.sourceId, `source:${profile.agentId}`);
    const result = ToolResultSchema.parse(JSON.parse(Buffer.from(await profile.services.artifacts.get(state.attempts[0]!.resultArtifact!, state.policy)).toString()));
    const observed = h.toolCalls.find(value => value.workId === state.id)!;
    assert.deepEqual(result.output, { sourceText: observed.sourceText, evidenceIds: ['doc-current'] });
    assert.equal(result.evidence[0]!.locator, `fixture://host/${profile.agentId}`);
    assert.equal((await readGeneratedAnswer(profile.services, state))!.text, `[합성 규칙 결과] 현재 근거 doc-current의 보존기간은 ${period}일입니다.`);
    const inputs = h.modelCalls.filter(value => value.agentId === profile.agentId);
    assert.ok(inputs.every(value => value.input.packet.policy.allowedTools.every(id => id === 'fixture.read')));
    assert.ok(inputs.every(value => value.options.tools.every(tool => tool.id === 'fixture.read')));
    assert.equal(state.budget.reservedTokens, 0); assert.equal(state.budget.reservedToolCalls, 0);
  }
  await assert.rejects(left.sessions.history(left.actor, y.sessionId, left.policy, { limit: 20 }));
  await assert.rejects(right.resources.evidence(x.workId, right.actor, 'doc-current', 4096), /work_unavailable/);
  assert.equal(await left.services.state.get(y.workId), null); assert.equal(await right.services.state.get(x.workId), null);
  await f.close(left);
  assert.deepEqual(h.toolCloses, [left.agentId]); assert.deepEqual(h.modelCloses, [left.agentId]);
  const followup = await acceptHostRequest(right, 'right-still-live', requests.read, y.sessionId);
  assert.equal((await right.workflow.run(followup.workId, right.actor)).control.kind, 'complete');
  assert.equal(h.toolCalls.filter(value => value.agentId === right.agentId).length, 2);
  await f.close(right);
  const calls = h.modelCalls.length, sources = h.toolCalls.length, reopened = await f.open(a.root, h.host);
  const session = await reopened.sessions.open(reopened.actor, { channel: 'test', conversationId: 'host-tools' });
  assert.equal(session.scope.sessionId, x.sessionId);
  assert.equal((await reopened.workflow.run(x.workId, reopened.actor)).control.kind, 'complete');
  assert.equal(h.modelCalls.length, calls); assert.equal(h.toolCalls.length, sources);
  assert.ok((await reopened.sessions.history(reopened.actor, x.sessionId, reopened.policy, { limit: 20 })).entries.some(entry => entry.sourceId === 'same-message' && entry.text === requests.read));
});

test('an explicit empty host tool list supports a direct answer and never falls back to the built-in synthetic read source', { timeout: 60000 }, async t => {
  const f = hostToolFixture(t), ready = f.create('empty'), h = toolHost(); h.controls.empty = true; h.controls.policy.allowedTools = [];
  const profile = await f.open(ready.root, h.host);
  assert.deepEqual(profile.policy.allowedTools, []); assert.deepEqual(profile.catalog.search(profile.policy, { query: 'read', limit: 20 }).cards, []);
  const direct = await acceptHostRequest(profile, 'direct', requests.rewrite);
  assert.equal((await profile.workflow.run(direct.workId, profile.actor)).control.kind, 'complete');
  const missing = await acceptHostRequest(profile, 'missing-read', requests.read, direct.sessionId);
  const result = await profile.workflow.run(missing.workId, profile.actor);
  assert.equal(result.control.kind, 'wait'); assert.equal(result.control.reason, 'pending_obligation');
  assert.equal(h.toolCalls.length, 0); assert.ok(h.modelCalls.every(value => value.options.tools.length === 0));
  const state = await profile.runtime.state(missing.workId); assert.deepEqual(state.evidence, []); assert.deepEqual(state.attempts, []);
  assert.ok(state.obligations.some(value => value.kind === 'response' && value.status === 'pending'));
  assert.equal((await profile.services.state.deliveries(state.id)).filter(value => value.kind === 'result').length, 0);
});

test('the host explicitly chooses core permissions while skills off removes guidance without reading its invalid catalog', async t => {
  const f = hostToolFixture(t), ready = f.create('permissions'), h = toolHost();
  h.controls.policy.allowedTools = ['fixture.read', 'core.evidence.get', 'core.guidance.find', 'core.guidance.load'];
  writeFileSync(join(ready.paths.skills, 'catalog.json'), 'invalid JSON', { mode: 0o600 });
  const profile = await f.open(ready.root, h.host);
  assert.deepEqual(profile.policy.allowedTools, ['fixture.read', 'core.evidence.get']);
  assert.deepEqual(profile.actor.allowedTools, profile.policy.allowedTools);
  assert.deepEqual(h.rawPolicies[0]!.allowedTools, ['fixture.read', 'core.evidence.get', 'core.guidance.find', 'core.guidance.load']);
  assert.deepEqual(profile.catalog.search(profile.policy, { query: 'guidance', limit: 20 }).cards, []);
  assert.equal(profile.policy.allowedTools.some(id => id.startsWith('core.memory.')), false);
  assert.equal(profile.guidance.metrics().sourceReadCalls, 0); assert.ok(await profile.personalKnowledge(profile.actor));
  assert.equal(h.modelCalls.length, 0); assert.equal(h.toolCalls.length, 0);
});

test('reopening with narrower tools, labels, destinations or a different user rejects old work without resetting its policy and usage', { timeout: 60000 }, async t => {
  const f = hostToolFixture(t), ready = f.create('reopen'), h = toolHost(); let profile = await f.open(ready.root, h.host);
  const completed = await acceptHostRequest(profile, 'completed', requests.read);
  assert.equal((await profile.workflow.run(completed.workId, profile.actor)).control.kind, 'complete');
  const done = await profile.runtime.state(completed.workId), pending = await acceptHostRequest(profile, 'pending', requests.read, completed.sessionId);
  const untouched = await profile.runtime.state(pending.workId), calls = h.modelCalls.length, reads = h.toolCalls.length;
  const restrictions: Policy[] = [
    { ...hostPolicy, allowedTools: [] }, { ...hostPolicy, allowedLabels: [] },
    { ...hostPolicy, allowedDestinations: [] }, { ...hostPolicy, principalId: 'another-user' },
  ];
  for (const policy of restrictions) {
    await f.close(profile); h.controls.policy = structuredClone(policy); profile = await f.open(ready.root, h.host);
    await assert.rejects(profile.workflow.run(pending.workId, profile.actor), /workflow_policy_insufficient|work_unavailable|execution_authority_denied/);
    if (!policy.allowedLabels.length || policy.principalId !== hostPolicy.principalId)
      await assert.rejects(profile.resources.evidence(completed.workId, profile.actor, 'doc-current', 4096));
    assert.equal(h.modelCalls.length, calls); assert.equal(h.toolCalls.length, reads);
    assert.deepEqual(await profile.runtime.state(pending.workId), untouched);
    assert.deepEqual((await profile.runtime.state(completed.workId)).budget, done.budget);
  }
  await f.close(profile); h.controls.policy = structuredClone(hostPolicy);
  h.controls.limits = { toolCalls: 2, modelCalls: 4, tokens: 300_000, replans: 1, wallTimeMs: 60000 };
  profile = await f.open(ready.root, h.host);
  const fresh = await acceptHostRequest(profile, 'new-defaults', requests.rewrite, completed.sessionId);
  assert.deepEqual(fresh.state.budget.limits, h.controls.limits);
  const preserved = await profile.runtime.state(completed.workId);
  assert.deepEqual(preserved.budget, done.budget); assert.equal(preserved.deadlineAt, done.deadlineAt);
  assert.deepEqual((await profile.runtime.state(pending.workId)).budget.limits, hostLimits);
});

test('a tool factory failure preserves the original exception, closes acquired stores and never opens a model fallback', async t => {
  const f = hostToolFixture(t), ready = f.create('factory-failure'), h = toolHost(), original = new Error('host_tool_open_failed');
  h.controls.toolOpenError = original;
  const close = SqliteStateRepository.prototype.close; let closed: SqliteStateRepository | undefined;
  SqliteStateRepository.prototype.close = async function () { await close.call(this); closed = this; };
  try {
    await assert.rejects(openAgentTurnProfile(ready.root, { provider: 'registered' }, { ...h.host, ...f.hostOptions }), error => error === original);
    assert.equal(h.modelOpens.length, 0); assert.equal(h.toolCloses.length, 0); assert.equal(h.toolCalls.length, 0);
    assert.ok(closed); await assert.rejects(closed.get('absent'));
  } finally { SqliteStateRepository.prototype.close = close; }
});

test('a model factory failure still closes the acquired host tools and preserves their independent cleanup error', async t => {
  const f = hostToolFixture(t), ready = f.create('model-failure'), h = toolHost();
  const primary = new Error('host_model_open_failed'), cleanup = new Error('host_tool_cleanup_failed');
  h.controls.modelOpenError = primary; h.controls.toolCloseError = cleanup;
  const close = SqliteStateRepository.prototype.close; let closed: SqliteStateRepository | undefined;
  SqliteStateRepository.prototype.close = async function () { await close.call(this); closed = this; };
  try {
    await assert.rejects(openAgentTurnProfile(ready.root, { provider: 'registered' }, { ...h.host, ...f.hostOptions }), error => {
      assert.ok(error instanceof AggregateError); assert.equal(error.cause, primary); assert.deepEqual(errorLeaves(error), [primary, cleanup]); return true;
    });
    assert.deepEqual(h.toolCloses, [ready.identity.agentId]); assert.equal(h.modelCloses.length, 0);
    assert.ok(closed); await assert.rejects(closed.get('absent'));
  } finally { SqliteStateRepository.prototype.close = close; }
});

test('composition failure preserves its parse error and closes model, tools and stores even when both host cleanups fail', async t => {
  const f = hostToolFixture(t), ready = f.create('compose-failure', 'sqlite', 'on-demand'), h = toolHost();
  writeFileSync(join(ready.paths.skills, 'catalog.json'), 'invalid JSON', { mode: 0o600 });
  const modelError = new Error('host_model_cleanup_failed'), toolError = new Error('host_tool_cleanup_failed');
  h.controls.modelCloseError = modelError; h.controls.toolCloseError = toolError;
  const close = SqliteStateRepository.prototype.close; let closed: SqliteStateRepository | undefined;
  SqliteStateRepository.prototype.close = async function () { await close.call(this); closed = this; };
  try {
    await assert.rejects(openAgentTurnProfile(ready.root, { provider: 'registered' }, { ...h.host, ...f.hostOptions }), error => {
      assert.ok(error instanceof AggregateError); assert.ok(error.cause instanceof SyntaxError);
      const leaves = errorLeaves(error); assert.equal(leaves[0], error.cause);
      assert.equal(leaves.filter(value => value === modelError).length, 1); assert.equal(leaves.filter(value => value === toolError).length, 1);
      assert.equal(leaves.length, 3); return true;
    });
    assert.deepEqual(h.toolCloses, [ready.identity.agentId]); assert.deepEqual(h.modelCloses, [ready.identity.agentId]);
    assert.ok(closed); await assert.rejects(closed.get('absent'));
  } finally { SqliteStateRepository.prototype.close = close; }
});

test('repeated profile close shares one failure, invokes each host closer once and closes the stores', async t => {
  const f = hostToolFixture(t), ready = f.create('close-failure'), h = toolHost();
  const modelError = new Error('model_close'), toolError = new Error('tool_close');
  h.controls.modelCloseError = modelError; h.controls.toolCloseError = toolError;
  const profile = await f.open(ready.root, h.host);
  try {
    const first = profile.close(), second = profile.close(); assert.equal(first, second);
    const [left, right] = await Promise.allSettled([first, second]);
    assert.equal(left.status, 'rejected'); assert.equal(right.status, 'rejected');
    if (left.status !== 'rejected' || right.status !== 'rejected') assert.fail('both close calls must retain the cleanup failure');
    assert.equal(left.reason, right.reason); assert.deepEqual(new Set(errorLeaves(left.reason)), new Set([modelError, toolError]));
    assert.deepEqual(h.modelCloses, [profile.agentId]); assert.deepEqual(h.toolCloses, [profile.agentId]);
    await assert.rejects(profile.services.state.get('absent'));
  } finally { f.untrack(profile); }
});

test('host evidence from another scope is rejected rather than relabelled into the current agent', { timeout: 60000 }, async t => {
  const f = hostToolFixture(t), ready = f.create('foreign-source'), h = toolHost(); h.controls.foreignScope = true;
  const profile = await f.open(ready.root, h.host), accepted = await acceptHostRequest(profile, 'foreign-read', requests.read);
  const call = await profile.planning!.reserve(accepted.workId); await profile.planning!.execute(accepted.workId, call.id);
  assert.equal(await profile.planning!.adopt(accepted.workId, call.id), true);
  for (const action of ['reserve', 'dispatch', 'adopt']) {
    const next = await profile.planning!.step(accepted.workId); assert.equal(next.kind, 'continue');
    if (next.kind !== 'continue') assert.fail('expected one real host read attempt'); assert.equal(next.action, action);
  }
  const state = await profile.runtime.state(accepted.workId);
  assert.equal(h.toolCalls.length, 1); assert.equal(state.evidence.length, 0); assert.notEqual(state.status, 'completed');
  assert.equal(state.attempts.length, 1); assert.ok(state.attempts[0]!.resultArtifact);
  assert.equal(h.returnedResults[0]!.evidence[0]!.scope, 'foreign-agent-scope');
  assert.equal(state.attempts[0]!.status, 'failed'); assert.equal(state.attempts[0]!.adopted, false);
  assert.equal(state.attempts[0]!.error?.code, 'invalid_tool_result');
  const stored = ToolResultSchema.parse(JSON.parse(Buffer.from(await profile.services.artifacts.get(state.attempts[0]!.resultArtifact!, state.policy)).toString()));
  assert.equal(stored.status, 'error'); assert.equal(stored.error?.code, 'invalid_tool_result'); assert.deepEqual(stored.evidence, []);
  assert.equal((await profile.services.state.deliveries(state.id)).filter(value => value.kind === 'result').length, 0);
});
