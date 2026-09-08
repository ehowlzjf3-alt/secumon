import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KnowledgeCard, KnowledgeSearch } from '../domain/knowledge.js';
import type { WorkState } from '../domain/model.js';
import type { WorkViewResult } from '../domain/work-view.js';
import type { WebAcceptResult, WebCommandResult, WebConversation, WorkList } from '../presentation/web-contracts.js';
import { deploymentFixture, deploymentRequest, type DeploymentSpec, type DeploymentWeb } from './agent-deployment-entry-fixture.js';
import { WRITE_TOOL } from './host-write-computer-entry-fixture.js';

const run = { requestId: 'same-run', kind: 'run', expectedGoalRevision: 1 } as const;
async function accept(web: DeploymentWeb, requestId: string, rawText: string) {
  const result = await web.request<WebAcceptResult>('/api/requests', { requestId, rawText, mode: 'auto' });
  assert.ok(result.sessionId); assert.equal(result.accepted, true); return { ...result, sessionId: result.sessionId };
}
function completed(result: WebCommandResult, spec: DeploymentSpec) {
  assert.equal(result.view.kind, 'snapshot'); if (result.view.kind !== 'snapshot') assert.fail('missing work snapshot');
  assert.equal(result.view.view.progress.status, 'completed', JSON.stringify(result.view.view.progress));
  assert.equal(result.view.view.progress.resultDelivery, 'delivered');
  assert.equal(result.view.view.messages.find(message => message.kind === 'result')?.text, spec.sourceText);
}
function ownExecution(web: DeploymentWeb, state: WorkState, spec: DeploymentSpec, foreign: DeploymentSpec) {
  assert.equal(state.goal.scope, web.app.profile.general!.scope);
  assert.equal(state.policy.tenantId, 'deployment-company'); assert.equal(state.policy.principalId, 'same-operator');
  assert.deepEqual(state.attempts.map(attempt => attempt.toolId), ['core.guidance.load', spec.toolId]);
  assert.ok(state.attempts.every(attempt => attempt.status === 'succeeded' && attempt.adopted));
  assert.equal(state.evidence.length, 1); assert.equal(state.evidence[0]!.sourceId, spec.toolId);
  assert.equal(state.evidence[0]!.facts.summary, spec.sourceText); assert.equal(state.evidence[0]!.scope, state.goal.scope);
  assert.equal(state.budget.used.toolCalls, 2); assert.equal(state.budget.used.modelCalls, 3);
  assert.equal(web.observed.reads, 1); assert.equal(web.observed.inputs.length, 3);
  for (const input of web.observed.inputs) {
    assert.equal(input.prompt.profile.agentId, web.app.profile.general!.agentId);
    assert.equal(input.prompt.profile.purpose, spec.purpose); assert.equal(input.prompt.profile.skillsMode, spec.skillsMode);
    assert.deepEqual([...input.packet.activeToolIds].sort(), ['core.guidance.load', spec.toolId].sort());
    assert.equal(input.packet.session?.basis.scope.agentId, web.app.profile.general!.agentId);
    for (const secret of [foreign.purpose, foreign.sourceText, foreign.preference, foreign.skillId, foreign.skillBody, foreign.toolId])
      assert.equal(JSON.stringify(input).includes(secret), false, `foreign deployment content: ${secret}`);
  }
  assert.ok(web.observed.inputs.some(input => input.packet.activeGuidance?.some(guide => guide.id === spec.skillId && guide.body === spec.skillBody)));
}
function collaborationOff(web: DeploymentWeb, allowMemorySelection = false) {
  const profile = web.app.profile.general!;
  assert.equal(profile.archive, null); assert.equal(profile.missions, null); assert.equal(profile.a2a, null);
  assert.deepEqual(profile.missionSources, []);
  assert.ok(profile.policy.allowedTools.every(id => id === 'core.guidance.load' || !id.startsWith('core.')));
  assert.equal(profile.policy.allowWrites, allowMemorySelection); assert.equal(profile.actor.allowWrites, allowMemorySelection);
}
function noWriteExecution(web: DeploymentWeb) {
  const profile = web.app.profile.general!, observed = web.writeHost;
  assert.ok(observed); assert.ok(profile.contracts.get(WRITE_TOOL, '1'));
  assert.equal(profile.policy.allowedTools.includes(WRITE_TOOL), false);
  assert.equal(profile.contracts.checkExecution({ id: 'forbidden-write', description: 'Registered but not permitted', toolId: WRITE_TOOL,
    toolVersion: '1', effect: 'write', input: { text: 'reviewed' }, dependsOn: [], maxAttempts: 1, satisfies: [] }, profile.policy), 'tool_permission_denied');
  assert.equal(observed.writes, 0); assert.equal(observed.validations, 0); assert.equal(observed.effectChecks, 0);
  assert.equal(observed.inputs.length, 0);
}

test('two business deployments use one engine through HTTP with distinct configuration, tools and selected skills, and isolated work/session reopen', async t => {
  const f = deploymentFixture(t), [research, review] = f.deployments;
  assert.ok(research && review); assert.notEqual(research.agentId, review.agentId);
  const a = await research.open(), b = await review.open();
  for (const web of [a, b]) collaborationOff(web);
  assert.equal(a.app.profile.general!.stateBackend, 'sqlite'); assert.equal(a.config.personalMemoryBackend, 'documents');
  assert.equal(b.app.profile.general!.stateBackend, 'file-journal'); assert.equal(b.config.personalMemoryBackend, 'sqlite');
  const first = await accept(a, 'same-input', deploymentRequest(research.spec));
  const second = await accept(b, 'same-input', deploymentRequest(review.spec));
  assert.notEqual(first.workId, second.workId); assert.notEqual(first.sessionId, second.sessionId);
  const untouched = await b.app.profile.general!.runtime.state(second.workId);
  completed(await a.request<WebCommandResult>(`/api/works/${first.workId}/commands`, run), research.spec);
  assert.deepEqual(await b.app.profile.general!.runtime.state(second.workId), untouched);
  assert.equal(b.observed.inputs.length, 0); assert.equal(b.observed.reads, 0);
  completed(await b.request<WebCommandResult>(`/api/works/${second.workId}/commands`, run), review.spec);
  const states = [await a.app.profile.general!.runtime.state(first.workId), await b.app.profile.general!.runtime.state(second.workId)];
  ownExecution(a, states[0]!, research.spec, review.spec); ownExecution(b, states[1]!, review.spec, research.spec);
  for (const [web, own, other, spec] of [[a, first, second, research.spec], [b, second, first, review.spec]] as const) {
    const history = await web.request<WebConversation>('/api/conversation');
    assert.equal(history.sessionId, own.sessionId);
    assert.deepEqual(history.entries.filter(entry => entry.role === 'user').map(entry => entry.text), [deploymentRequest(spec)]);
    assert.equal(history.entries.filter(entry => entry.role === 'assistant' && entry.text === spec.sourceText).length, 1);
    const listed = await web.request<WorkList>('/api/works'); assert.deepEqual(listed.items.map(item => item.workId), [own.workId]);
    assert.equal((await web.request<{ code: string }>(`/api/works/${other.workId}/view`, undefined, 404)).code, 'work_not_found');
    assert.deepEqual((await web.request<Pick<KnowledgeSearch, 'cards' | 'index'>>('/api/memories')).cards, [], 'running a task must not automatically save personal memory');
  }
  await a.app.close(); await b.app.close();
  assert.equal(a.observed.toolCloses, 1); assert.equal(a.observed.modelCloses, 1);
  assert.equal(b.observed.toolCloses, 1); assert.equal(b.observed.modelCloses, 1);
  await assert.rejects(research.open(second.sessionId), /session_unavailable/);
  const reopened = [await research.open(first.sessionId), await review.open(second.sessionId)];
  for (const [index, deployment] of f.deployments.entries()) {
    const web = reopened[index]!, accepted = [first, second][index]!;
    const duplicate = await web.request<WebAcceptResult>('/api/requests', { requestId: 'same-input', rawText: deploymentRequest(deployment.spec), mode: 'auto' });
    assert.equal(duplicate.accepted, false); assert.equal(duplicate.workId, accepted.workId); assert.equal(duplicate.sessionId, accepted.sessionId);
    const rerun = await web.request<WebCommandResult>(`/api/works/${accepted.workId}/commands`, run);
    assert.equal(rerun.duplicate, true); completed(rerun, deployment.spec);
    await web.request<WorkViewResult>(`/api/works/${accepted.workId}/view`); await web.request('/api/conversation');
    assert.deepEqual(await web.app.profile.general!.runtime.state(accepted.workId), states[index]);
    assert.equal(web.observed.reads, 0); assert.equal(web.observed.inputs.length, 0);
    assert.deepEqual(readFileSync(join(deployment.directory, 'config.json')), deployment.configBytes);
    assert.deepEqual(readFileSync(join(deployment.directory, 'skills', 'catalog.json')), deployment.catalogBytes);
    assert.deepEqual(f.profiles.inspect(deployment.directory).status, 'ready');
  }
});

test('two deployments keep same-ID personal memories separate through HTTP recall and later work without collaboration or automatic evidence promotion', async t => {
  const f = deploymentFixture(t, { allowMemorySelection: true }), [research, review] = f.deployments; assert.ok(research && review);
  const initial = [await research.open(), await review.open()];
  const sources: Awaited<ReturnType<typeof accept>>[] = [], sourceStates: WorkState[] = [];
  for (const [index, deployment] of f.deployments.entries()) {
    const web = initial[index]!, source = await accept(web, 'same-source', deployment.spec.preference); sources.push(source);
    const profile = web.app.profile.general!, before = await profile.runtime.state(source.workId); sourceStates.push(before);
    // Seed through the existing trusted host service; public HTTP selection below
    // requires the explicitly enabled work-actor state-editing permission.
    const memory = await profile.personalKnowledge(profile.actor);
    const saved = await memory.remember({ id: 'same-preference', commandId: 'same-save', title: '담당 표현 방식',
      source: { sessionId: source.sessionId, messageId: 'same-source', quote: deployment.spec.preference } });
    assert.equal(saved.card.owner?.agentId, deployment.agentId); assert.equal(saved.card.owner?.principalId, 'same-operator');
    assert.equal(saved.card.body, deployment.spec.preference); assert.equal(saved.card.revision, 1);
    assert.deepEqual(await profile.runtime.state(source.workId), before);
    assert.equal(web.observed.reads, 0); assert.equal(web.observed.inputs.length, 0);
    collaborationOff(web, true); noWriteExecution(web);
  }
  const memoryA = await initial[0]!.app.profile.general!.personalKnowledge(initial[0]!.app.profile.general!.actor);
  await assert.rejects(memoryA.remember({ id: 'foreign-source', commandId: 'foreign-source', title: '다른 담당의 입력',
    source: { sessionId: sources[1]!.sessionId, messageId: 'same-source', quote: review.spec.preference } }), /^Error: session_unavailable$/);
  for (const web of initial) { await web.app.close(); assert.equal(web.writeHost!.toolCloses, 1); }
  const reopened = [await research.open(sources[0]!.sessionId), await review.open(sources[1]!.sessionId)];
  for (const [index, deployment] of f.deployments.entries()) {
    const web = reopened[index]!, profile = web.app.profile.general!, other = f.deployments[1 - index]!;
    collaborationOff(web, true);
    const read = await web.request<{ card: KnowledgeCard }>('/api/memories/same-preference');
    assert.equal(read.card.body, deployment.spec.preference); assert.equal(read.card.owner?.agentId, deployment.agentId);
    const cards = (await web.request<Pick<KnowledgeSearch, 'cards' | 'index'>>('/api/memories')).cards;
    assert.deepEqual(cards.map(card => card.id), ['same-preference']);
    const next = await accept(web, 'same-next', deploymentRequest(deployment.spec));
    assert.notEqual(next.workId, sources[index]!.workId); assert.equal(next.sessionId, sources[index]!.sessionId);
    const state = await profile.runtime.state(next.workId);
    assert.equal(state.personalMemorySelection, undefined); assert.deepEqual(state.evidence, []);
    const selection = { requestId: 'same-recall', expectedGoalRevision: state.goal.revision, expectedStateRevision: state.revision,
      refs: [{ id: 'same-preference', revision: 1 }] };
    const selected = await web.request<{ applied: boolean }>(`/api/works/${next.workId}/memories`, selection); assert.equal(selected.applied, true);
    assert.equal((await web.request<{ applied: boolean }>(`/api/works/${next.workId}/memories`, selection)).applied, false);
    const prepared = await profile.runtime.state(next.workId);
    assert.deepEqual(prepared.evidence, []); assert.deepEqual(prepared.attempts, []); assert.deepEqual(prepared.modelCalls, []);
    assert.equal(prepared.budget.used.toolCalls, 0); assert.equal(prepared.budget.used.modelCalls, 0);
    assert.deepEqual(await profile.runtime.state(sources[index]!.workId), sourceStates[index]);
    completed(await web.request<WebCommandResult>(`/api/works/${next.workId}/commands`, run), deployment.spec);
    const done = await profile.runtime.state(next.workId); ownExecution(web, done, deployment.spec, other.spec);
    for (const input of web.observed.inputs) {
      assert.equal(input.packet.personalMemory?.interpretation, 'user_requested_memory_not_verified_evidence');
      assert.deepEqual(input.packet.personalMemory?.entries.map(entry => entry.body), [deployment.spec.preference]);
      assert.equal(input.packet.personalMemory?.entries[0]!.ref.agentId, deployment.agentId);
      assert.ok(input.packet.evidence.every(evidence => evidence.facts.summary !== deployment.spec.preference));
    }
    assert.deepEqual(await profile.runtime.state(sources[index]!.workId), sourceStates[index]);
    const history = await web.request<WebConversation>('/api/conversation');
    assert.deepEqual(history.entries.filter(entry => entry.role === 'user').map(entry => entry.text), [deployment.spec.preference, deploymentRequest(deployment.spec)]);
    assert.equal(JSON.stringify(history).includes(other.spec.preference), false);
    noWriteExecution(web);
    await web.app.close(); assert.equal(web.writeHost!.toolCloses, 1);
  }
});
