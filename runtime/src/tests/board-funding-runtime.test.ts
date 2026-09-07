import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { boardRequestFixture } from './helpers/board-request-fixture.js';
import { adapters, type Adapter } from './state-conformance-helpers.js';
import { BoardFunding, type BoardFundingProfile } from '../application/board-funding.js';
import { BudgetRuntimeRouter } from '../application/budget-runtime-router.js';
import { composeRuntime } from '../application/compose-runtime.js';
import type { InputAuthority } from '../application/knowledge-ports.js';
import type { TaskSpec, ToolResult } from '../domain/model.js';
import type { ModelReply, Tool } from '../application/ports.js';
import { ToolResultSchema } from '../application/contracts.js';
import { BoardRequestPageSchema } from '../application/board-contracts.js';
import { FakeSink, ScriptedPlanner } from '../infrastructure/fakes.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { totalExposure } from '../domain/budget-delegation.js';
import { ContextRecovery } from '../application/context-recovery.js';
import { assertBudgetAuthority } from '../application/budget-delegation.js';

async function fixture(t: TestContext, adapter: Adapter, family = 'documents') {
  const f = await boardRequestFixture(t, adapter, family); let seq = 0;
  f.actors['b']!.allowedLabels.push('role-private');
  await f.edit('a', state => { state.budget.limits.tokens = 100000; state.budget.limits.modelCalls = 20; });
  const base = (await f.state.get('work-b'))!;
  const profile: BoardFundingProfile = { id: 'worker-profile', revision: 1, boardId: 'board', sponsorRoleId: 'role-a', workerRoleId: 'role-b',
    policy: { ...base.policy, allowedTools: [...base.policy.allowedTools, 'fixture.read'], allowedLabels: ['synthetic', 'role-private'] },
    goal: { ...base.goal, mode: 'deep', description: 'Resolve the assigned question using this role sources' },
    maximum: { toolCalls: 20, modelCalls: 4, tokens: 30000, replans: 20, wallTimeMs: 50000 } };
  const profiles = { get: async (id: string) => id === profile.id ? structuredClone(profile) : null };
  const authority: InputAuthority = { resolve: async identity => {
    const source = Object.values(f.actors).find(actor => actor.tenantId === identity.tenantId && actor.principalId === identity.principalId);
    if (!source) return null; const { canManageBoards: _manage, ...actor } = source; return structuredClone(actor);
  } };
  const planner = new ScriptedPlanner([packet => ({ status: 'ok', provider: 'scripted', model: 'fixture', inputTokens: 80, outputTokens: 20,
    proposal: { baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
      reason: 'Collect an independent original in this role', hypotheses: [], tasks: [{ id: 'original', description: 'Read role source', toolId: 'fixture.read', toolVersion: '1',
        input: {}, effect: 'read', dependsOn: [], maxAttempts: 1, satisfies: [] }] } } satisfies ModelReply)]);
  let sourceCalls = 0;
  const tool: Tool = { definition: { id: 'fixture.read', version: '1', provider: 'fixture', description: 'Read local synthetic role source', effect: 'read', destination: 'local', labels: ['synthetic'],
    inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' } },
    async execute(_task, context): Promise<ToolResult> {
      await context.authorize?.(); sourceCalls++;
      const artifact = await f.artifacts.put(new TextEncoder().encode(`funded original ${family}`), { tenantId: 'tenant-a', labels: ['synthetic'], mediaType: 'text/plain' });
      return { resultId: `${context.attemptId}:result`, attemptId: context.attemptId, status: 'success', effectState: 'none', output: { available: true }, coverage: 'complete', error: null, cursor: null,
        artifacts: [artifact], evidence: [{ id: 'funded-e1', tenantId: 'tenant-a', scope: 'fixture', sourceId: `funded-${family}`, lineageId: `funded-${family}`, locator: `local:${family}`,
          labels: ['synthetic'], observedAt: f.clock.now(), recordedAt: f.clock.now(), coverage: 'complete', status: 'accepted', derivedFrom: [], supersedes: [], artifact,
          facts: { available: true, value: family === 'documents' ? '30 days' : 'normal' } }], usage: { transportCalls: 1, internalOperations: 1, imageBytes: 0, waitMs: 0 } };
    } };
  const wire = async () => {
    const services = f.bundle('a').services;
    const funding = new BoardFunding({ services, repository: f.repository, authority, profiles });
    const router = new BudgetRuntimeRouter(f.state); services.budgetAuthority = funding; services.budgetChildren = router;
    const worker = await composeRuntime({ services: { state: f.state, artifacts: f.artifacts, clock: f.clock, ids: services.ids, digester: services.digester,
      tools: [tool], planner, sink: new FakeSink(), budgetAuthority: funding, budgetChildren: router },
      board: { repository: f.repository, authority, actors: { current: async () => structuredClone(f.actors['b']!) } },
      guidanceSource: { list: async () => [], read: async () => { throw new Error('unused'); } }, schemas: new AjvSchemas(), owner: `funded-worker-${++seq}`, leaseMs: 10000 });
    router.register({ tenantId: 'tenant-a', principalId: 'person-a' }, services, id => f.bundle('a').runtime.interrupt(id));
    router.register({ tenantId: 'tenant-a', principalId: 'person-b' }, worker.services, id => worker.runtime.interrupt(id));
    return { funding, router, worker };
  };
  let wired = await wire(); const actor = { tenantId: 'tenant-a', principalId: 'person-a' };
  const input = () => ({ profileId: profile.id, profileRevision: profile.revision, boardId: 'board', requestId: 'request', limits: structuredClone(profile.maximum) });
  const allocate = (commandId = 'allocate-request', args = input()) => wired.funding.allocate('work-a', commandId, actor, 1, args);
  const task = (toolId: string, input: TaskSpec['input']): TaskSpec => ({ id: `funding-task-${++seq}`, description: 'Process assigned collaboration',
    toolId, toolVersion: '1', effect: ['core.board.read', 'core.board.requests.read', 'fixture.read'].includes(toolId) ? 'read' : 'write',
    input, dependsOn: [], maxAttempts: 1, satisfies: [] });
  const plan = async (workId: string, selected: TaskSpec) => {
    await wired.worker.services.effects!.refresh(workId); const current = (await f.state.get(workId))!;
    await wired.worker.runtime.submitPlan(workId, `funding-plan-${++seq}`, { baseStateRevision: current.revision, baseGoalRevision: current.goal.revision,
      basePlanRevision: current.plan?.revision ?? 0, tasks: [selected], hypotheses: [], reason: 'Act on the assigned request' });
    return selected;
  };
  const run = async (workId: string, selected: TaskSpec) => {
    const attempt = await wired.worker.runtime.reserve(workId, selected.id);
    await wired.worker.runtime.execute(workId, attempt.id); await wired.worker.runtime.settlePending(attempt.id); await wired.worker.runtime.adopt(workId, attempt.id);
    await wired.worker.services.effects!.refresh(workId);
    const state = (await f.state.get(workId))!, stored = state.attempts.find(value => value.id === attempt.id)!;
    const result = stored.resultArtifact ? ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await f.artifacts.get(stored.resultArtifact, state.policy)))) : null;
    assert.equal(stored.adopted, true, JSON.stringify({ stored, result })); return { state, attempt: stored, result };
  };
  const execute = async (workId: string, toolId: string, input: TaskSpec['input']) => run(workId, await plan(workId, task(toolId, input)));
  const requests = async (workId: string) => {
    const result = await execute(workId, 'core.board.requests.read', { boardId: 'board', requestId: 'request', maxRequests: 20, maxBytes: 32768 });
    return BoardRequestPageSchema.parse(result.result!.output);
  };
  const accept = async (workId: string) => {
    await execute(workId, 'core.board.read', { boardId: 'board', entityId: 'entity', maxPosts: 20, maxBytes: 32768 });
    const page = await requests(workId);
    return execute(workId, 'core.board.requests.accept', { boardId: page.boardId, requestId: page.requests[0]!.id, expectedRevision: page.revision });
  };
  return { f, profile, profiles, planner, authority, actor, input, allocate, task, plan, run, execute, requests, accept,
    get funding() { return wired.funding; }, get worker() { return wired.worker; }, get router() { return wired.router; }, get sourceCalls() { return sourceCalls; },
    async reopen() { await f.reopen(); wired = await wire(); } };
}

for (const adapter of adapters) for (const family of ['documents', 'observations']) test(`board funding ${adapter}/${family}: allocated public-data role reads, accepts, reasons, answers and settles`, { timeout: 180000 }, async t => {
  const h = await fixture(t, adapter, family); h.profile.policy.allowedLabels = ['synthetic']; await h.f.offer(); const funded = await h.allocate();
  await assert.rejects(h.worker.planning!.reserve(funded.workId), /budget_authority_denied/); assert.equal(h.planner.inputs.length, 0);
  await assert.rejects(h.plan(funded.workId, h.task('fixture.read', {})), /budget_authority_denied/);
  await h.accept(funded.workId);
  const model = await h.worker.planning!.reserve(funded.workId); await h.worker.planning!.execute(funded.workId, model.id);
  await h.worker.planning!.settlePending(); assert.equal(await h.worker.planning!.adopt(funded.workId, model.id), true);
  const planned = (await h.f.state.get(funded.workId))!.plan!.tasks.find(task => task.id === 'original')!;
  await h.run(funded.workId, planned); assert.equal(h.sourceCalls, 1);
  await assert.rejects(new ContextRecovery(h.worker.services, h.worker.contracts).restore(funded.workId, h.actor), /work_unavailable/);
  await h.execute(funded.workId, 'core.board.publish', { ...await h.f.mutation(), id: 'answer', entityId: 'entity', kind: 'observation',
    body: 'Answer supported by a separately collected original', labels: ['synthetic'], evidenceIds: ['funded-e1'], quotedPostIds: [], replyTo: 'question', relation: 'clarifies', causeId: 'answer', expiresAt: null });
  await h.execute(funded.workId, 'core.board.requests.answer', { ...await h.f.mutation(), requestId: 'request', postId: 'answer' });
  assert.notEqual((await h.worker.runtime.step(funded.workId)).kind, 'complete');
  const before = (await h.f.state.get(funded.workId))!;
  const resumed = await new ContextRecovery(h.worker.services, h.worker.contracts).restore(funded.workId, before.policy);
  assert.equal(resumed.packet.runtime.delegation!.parentPhase, 'active');
  await h.reopen(); await h.f.confirm();
  assert.equal((await h.worker.runtime.runUntilYield(funded.workId, 3)).kind, 'complete');
  const grant = await h.f.bundle('a').runtime.budgets.reconcile('work-a', funded.grantId, h.actor);
  assert.equal(grant.status, 'settled'); assert.equal(grant.accounted.toolCalls, 6); assert.equal(grant.accounted.modelCalls, 1);
  assert.equal((await h.f.state.get('work-a'))!.evidence.length, 1); assert.equal(h.planner.inputs.length, 1);
  assert.equal(totalExposure((await h.f.state.get('work-a'))!).toolCalls, 10);
});

for (const adapter of adapters) {
  for (const action of ['other-board', 'other-request', 'broad-read', 'other-entity', 'ordinary-tool', 'publish'] as const)
    test(`board funding ${adapter}: offered work rejects ${action} preparation`, async t => {
      const h = await fixture(t, adapter); await h.f.offer(); const funded = await h.allocate();
      let selected = h.task('core.board.requests.read', { boardId: 'board', requestId: 'request', maxRequests: 20, maxBytes: 32768 });
      if (action === 'other-board') selected.input['boardId'] = 'foreign-board';
      if (action === 'other-request') selected.input['requestId'] = 'foreign-request';
      if (action === 'broad-read') selected = h.task('core.board.read', { boardId: 'board', maxPosts: 20, maxBytes: 32768 });
      if (action === 'other-entity') selected = h.task('core.board.read', { boardId: 'board', entityId: 'unrelated', maxPosts: 20, maxBytes: 32768 });
      if (action === 'ordinary-tool') selected = h.task('fixture.read', {});
      if (action === 'publish') selected = h.task('core.board.publish', { ...await h.f.mutation(), id: 'premature', entityId: 'entity', kind: 'question',
        body: 'Premature task', labels: [], evidenceIds: [], quotedPostIds: [], replyTo: null, relation: null, causeId: 'premature', expiresAt: null });
      await assert.rejects(h.plan(funded.workId, selected), /budget_authority_denied/);
      assert.equal((await h.f.state.get(funded.workId))!.plan, null); assert.equal(h.sourceCalls, 0); assert.equal(h.planner.inputs.length, 0);
    });

  for (const change of ['profile', 'worker-authority', 'sponsor-authority'] as const)
    test(`board funding ${adapter}: ${change} withdrawal after preparation blocks dispatch and returns unused funds`, async t => {
      const h = await fixture(t, adapter); await h.f.offer(); const funded = await h.allocate();
      const selected = await h.plan(funded.workId, h.task('core.board.read', { boardId: 'board', entityId: 'entity', maxPosts: 20, maxBytes: 32768 }));
      const attempt = await h.worker.runtime.reserve(funded.workId, selected.id);
      if (change === 'profile') h.profile.revision++;
      if (change === 'worker-authority') h.f.actors['b']!.canPublish = false;
      if (change === 'sponsor-authority') h.f.actors['a']!.canPublish = false;
      await assert.rejects(h.worker.runtime.execute(funded.workId, attempt.id), /budget_|board_/);
      const grant = await h.f.bundle('a').runtime.budgets.reconcile('work-a', funded.grantId, h.actor);
      assert.equal(grant.status, 'settled'); assert.equal(grant.accounted.toolCalls, 0);
      assert.equal((await h.f.state.get(funded.workId))!.budget.reservedToolCalls, 0); assert.equal(h.sourceCalls, 0);
    });

  test(`board funding ${adapter}: insufficient duration is rejected before creating a child`, async t => {
    const h = await fixture(t, adapter); await h.f.offer(); const input = h.input(); input.limits.wallTimeMs = 1000;
    await assert.rejects(h.allocate('too-short', input), /budget_authority_denied/);
    const parent = (await h.f.state.get('work-a'))!; assert.equal(parent.budgetGrants?.length ?? 0, 0);
    assert.equal(await h.f.state.get(h.funding.childId(parent.id, h.funding.referenceId('board', 'request'))), null);
  });

  test(`board funding ${adapter}: a competing acceptance drains the prepared allocation without discharging the request`, async t => {
    const h = await fixture(t, adapter); await h.f.offer(); const funded = await h.allocate(); await h.f.accept();
    const grant = await h.f.bundle('a').runtime.budgets.reconcile('work-a', funded.grantId, h.actor);
    assert.equal(grant.status, 'settled'); assert.equal(grant.accounted.toolCalls, 0);
    const board = (await h.f.repository.get('tenant-a', 'board'))!;
    assert.equal(board.requests[0]!.status, 'accepted'); assert.equal(board.requests[0]!.acceptedWorkId, 'work-b');
    assert.ok((await h.f.state.get('work-a'))!.obligations.some(value => value.source && value.status === 'pending'));
  });

  test(`board funding ${adapter}: duplicate allocation across reopen keeps one grant and returns only numeric references`, async t => {
    const h = await fixture(t, adapter); await h.f.offer(); const first = await h.allocate(); await h.reopen();
    assert.deepEqual(await h.allocate(), first); assert.deepEqual(Object.keys(first).sort(), ['grantId', 'workId']);
    assert.equal((await h.f.state.get('work-a'))!.budgetGrants!.length, 1);
    await assert.rejects(h.allocate('different-command'), /idempotency_conflict/);
    assert.equal(h.sourceCalls, 0); assert.equal(h.planner.inputs.length, 0);
  });

  test(`board funding ${adapter}: a source-privileged worker does not hide the shared request metadata from its sponsor`, async t => {
    const h = await fixture(t, adapter); await h.f.offer(); const funded = await h.allocate(); await h.accept(funded.workId);
    const page = await h.f.readRequests('a', 'request'); assert.equal(page.page.requests[0]!.acceptedWorkId, funded.workId);
    assert.equal(JSON.stringify(page.page).includes('role-private'), false);
    assert.equal(JSON.stringify(page.page).includes(h.profile.goal.description), false);
    assert.deepEqual((await h.f.state.get('work-a'))!.policy.allowedLabels, ['synthetic']);
    const original = (await h.f.state.get(funded.workId))!.attempts.find(attempt => attempt.toolId === 'core.board.read')!.resultArtifact!;
    await assert.rejects(h.f.artifacts.get(original, (await h.f.state.get('work-a'))!.policy));
  });

  test(`board funding ${adapter}: altered child goal cannot use a valid request and profile reference`, async t => {
    const h = await fixture(t, adapter); await h.f.offer();
    const referenceId = h.funding.referenceId('board', 'request');
    await assert.rejects(h.f.bundle('a').runtime.budgets.createChild('work-a', 'altered-goal', h.actor, 1, {
      id: h.funding.childId('work-a', referenceId), policy: h.profile.policy, goal: { ...h.profile.goal, description: 'Unrelated work' },
      limits: h.profile.maximum, deadlineAt: 50000, mandate: { provider: 'board-funding', referenceId, revision: 1, childGoalRevision: 1,
        attributes: { boardId: 'board', requestId: 'request', profileId: h.profile.id } },
    }), /budget_authority_denied/);
    assert.equal((await h.f.state.get('work-a'))!.budgetGrants?.length ?? 0, 0);
  });

  test(`board funding ${adapter}: allocation rejects caller-selected policy fields and foreign sponsor ownership`, async t => {
    const h = await fixture(t, adapter); await h.f.offer();
    await assert.rejects(h.allocate('injected', { ...h.input(), policy: h.profile.policy } as ReturnType<typeof h.input>));
    await assert.rejects(h.funding.allocate('work-a', 'foreign', { ...h.actor, principalId: 'person-b' }, 1, h.input()), /actor_not_authorized/);
    assert.equal((await h.f.state.get('work-a'))!.budgetGrants?.length ?? 0, 0);
  });
}

for (const adapter of adapters) {
  test(`board funding ${adapter}: private answers stay hidden without falsely revoking their worker allocation`, async t => {
    const h = await fixture(t, adapter); await h.f.offer(); const funded = await h.allocate(); await h.accept(funded.workId);
    await h.execute(funded.workId, 'fixture.read', {});
    await h.execute(funded.workId, 'core.board.publish', { ...await h.f.mutation(), id: 'answer', entityId: 'entity', kind: 'observation',
      body: 'Private role analysis', labels: ['synthetic'], evidenceIds: ['funded-e1'], quotedPostIds: [], replyTo: 'question', relation: 'clarifies', causeId: 'answer', expiresAt: null });
    await h.execute(funded.workId, 'core.board.requests.answer', { ...await h.f.mutation(), requestId: 'request', postId: 'answer' });
    const answer = (await h.f.repository.get('tenant-a', 'board'))!.posts.find(post => post.id === 'answer')!;
    assert.ok(answer.labels.includes('role-private'));
    const read = await h.f.read('a'); assert.equal(JSON.stringify(read.result!.output).includes('Private role analysis'), false);
    const metadata = await h.f.readRequests('a', 'request'); assert.equal(metadata.page.requests[0]!.status, 'answered');
    assert.equal(JSON.stringify(metadata.page).includes('Private role analysis'), false);
    const pending = await h.f.prepare('a', 'core.board.requests.confirm', { ...await h.f.mutation(), requestId: 'request' });
    const runtime = h.f.bundle('a').runtime;
    await runtime.execute('work-a', pending.attempt.id); await runtime.settlePending(pending.attempt.id); await runtime.adopt('work-a', pending.attempt.id);
    const sponsor = await h.f.refresh('a'), attempt = sponsor.attempts.find(value => value.id === pending.attempt.id)!;
    assert.equal(attempt.adopted, false); assert.equal(attempt.effectReceipt?.outcome, 'not_applied');
    assert.equal((await h.f.repository.get('tenant-a', 'board'))!.requests[0]!.status, 'answered');
    assert.equal((await runtime.budgets.reconcile('work-a', funded.grantId, h.actor)).status, 'active');
    assert.notEqual((await h.worker.runtime.step(funded.workId)).kind, 'complete');
    await assert.rejects(new ContextRecovery(h.worker.services, h.worker.contracts).restore(funded.workId, h.actor), /work_unavailable/);
    assert.equal(h.sourceCalls, 1);
  });

  test(`board funding ${adapter}: a private question stays unavailable despite public coordination metadata handling`, async t => {
    const h = await fixture(t, adapter); h.f.actors['a']!.allowedLabels.push('question-private');
    await h.f.edit('a', state => { state.policy.allowedLabels.push('question-private'); });
    await h.f.execute('a', 'core.board.publish', { ...await h.f.mutation(), id: 'question', entityId: 'entity', kind: 'question', body: 'Classified question',
      labels: ['question-private'], evidenceIds: [], quotedPostIds: [], replyTo: null, relation: null, causeId: 'private-question', expiresAt: null });
    await h.f.execute('a', 'core.board.requests.offer', { ...await h.f.mutation(), id: 'request', questionId: 'question', toAgentId: 'role-b', deliverable: 'Cited answer', dueAt: 50000 });
    assert.deepEqual((await h.f.readRequests('b', 'request')).page.requests, []);
    await assert.rejects(h.allocate(), /budget_authority_denied/);
    assert.equal((await h.f.state.get('work-a'))!.budgetGrants?.length ?? 0, 0);
  });

  test(`board funding ${adapter}: request cancellation before acceptance returns the allocation without completing the goal`, async t => {
    const h = await fixture(t, adapter); await h.f.offer(); const funded = await h.allocate();
    await h.f.execute('a', 'core.board.requests.cancel', { ...await h.f.mutation(), requestId: 'request' });
    const grant = await h.f.bundle('a').runtime.budgets.reconcile('work-a', funded.grantId, h.actor);
    assert.equal(grant.status, 'settled'); assert.equal(grant.accounted.toolCalls, 0);
    assert.notEqual((await h.f.state.get(funded.workId))!.status, 'completed');
    await assert.rejects(h.worker.planning!.reserve(funded.workId)); assert.equal(h.planner.inputs.length, 0);
  });

  test(`board funding ${adapter}: an applied acceptance with a lost reply restores the same funded obligation after reopen`, async t => {
    const h = await fixture(t, adapter); await h.f.offer(); const funded = await h.allocate();
    await h.execute(funded.workId, 'core.board.read', { boardId: 'board', entityId: 'entity', maxPosts: 20, maxBytes: 32768 });
    const page = await h.requests(funded.workId);
    const selected = await h.plan(funded.workId, h.task('core.board.requests.accept', { boardId: 'board', requestId: 'request', expectedRevision: page.revision }));
    const original = h.f.repository.commit.bind(h.f.repository); let lost = false;
    h.f.repository.commit = async command => {
      const result = await original(command);
      if (!lost && result.kind === 'committed' && command.next.requests.some(request => request.acceptedWorkId === funded.workId)) { lost = true; throw new Error('synthetic_accept_reply_lost'); }
      return result;
    };
    const attempt = await h.worker.runtime.reserve(funded.workId, selected.id);
    await h.worker.runtime.execute(funded.workId, attempt.id); await h.worker.runtime.settlePending(attempt.id);
    await h.worker.runtime.adopt(funded.workId, attempt.id); assert.equal(lost, true);
    await h.reopen(); await h.worker.services.effects!.refresh(funded.workId);
    const state = (await h.f.state.get(funded.workId))!, stored = state.attempts.find(value => value.id === attempt.id)!;
    assert.equal(stored.effectReceipt?.outcome, 'applied'); assert.equal(stored.adopted, false);
    assert.equal(state.obligations.filter(value => value.source?.externalId === 'request').length, 1);
    assert.deepEqual(await h.allocate(), funded); assert.equal((await h.f.state.get('work-a'))!.budgetGrants!.length, 1);
    const call = await h.worker.planning!.reserve(funded.workId); await h.worker.planning!.execute(funded.workId, call.id); await h.worker.planning!.settlePending();
    assert.equal(await h.worker.planning!.adopt(funded.workId, call.id), true);
    assert.equal(h.planner.inputs.length, 1); assert.equal((await h.f.state.get(funded.workId))!.budget.used.toolCalls, 3);
  });

  test(`board funding ${adapter}: a profile change during the final actor lookup cannot authorize a stale preparation`, async t => {
    const h = await fixture(t, adapter); await h.f.offer(); const funded = await h.allocate();
    const original = h.authority.resolve; let workerReads = 0;
    h.authority.resolve = async identity => {
      const actor = await original(identity);
      if (identity.principalId === 'person-b' && ++workerReads === 2) h.profile.revision++;
      return actor;
    };
    const selected = h.task('core.board.read', { boardId: 'board', entityId: 'entity', maxPosts: 20, maxBytes: 32768 });
    await assert.rejects(assertBudgetAuthority(h.worker.services, (await h.f.state.get(funded.workId))!, {}, { kind: 'plan', tasks: [selected] }), /budget_|board_/);
    assert.equal(h.sourceCalls, 0); assert.equal(h.planner.inputs.length, 0);
  });
}
