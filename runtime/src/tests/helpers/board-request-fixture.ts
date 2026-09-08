import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeRuntime } from '../../application/compose-runtime.js';
import { BoardWorkSourceRegistry } from '../../application/board-work-source-registry.js';
import { BOARD_REQUEST_TOOLS, BOARD_WRITE_TOOLS } from '../../application/board-commands.js';
import { BOARD_READ_TOOL } from '../../application/board-tools.js';
import { ToolResultSchema } from '../../application/contracts.js';
import type { BoardActor } from '../../domain/board.js';
import type { BoardRepository } from '../../application/board-ports.js';
import type { TaskSpec, WorkState } from '../../domain/model.js';
import { FileBoardRepository } from '../../infrastructure/file-board.js';
import { SqliteBoardRepository } from '../../infrastructure/sqlite-board.js';
import { FileArtifactStore } from '../../infrastructure/file-artifacts.js';
import { AjvSchemas } from '../../infrastructure/ajv-schemas.js';
import { Sha256Digester } from '../../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner, SequenceIds } from '../../infrastructure/fakes.js';
import { advance, command, initial, openRepository, type Adapter } from '../state-conformance-helpers.js';

import { BOARD_REQUEST_READ_TOOL } from '../../application/board-request-tools.js';
import { BoardRequestPageSchema } from '../../application/board-contracts.js';
export async function boardRequestFixture(t: TestContext, adapter: Adapter, family = 'documents') {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-board-request-'));
  let state = openRepository(adapter, directory);
  const openBoard = (): BoardRepository => adapter === 'sqlite' ? new SqliteBoardRepository(join(directory, 'board.sqlite')) : new FileBoardRepository(join(directory, 'boards'));
  let repository = openBoard(); const artifacts = new FileArtifactStore(join(directory, 'artifacts'));
  const actors: Record<string, BoardActor> = Object.fromEntries(['a', 'b'].map(person => [person, { tenantId: 'tenant-a', principalId: `person-${person}`,
    allowedLabels: ['synthetic'], allowedScopes: ['fixture'], allowedNamespaces: ['team'], canPublish: true, canReview: false, canManageBoards: person === 'a' }]));
  const clock = new FakeClock(1100), ids = new SequenceIds(), digester = new Sha256Digester(); let sequence = 0;
  const workSources = new BoardWorkSourceRegistry(); let registrations: Array<() => void> = [];
  const compose = (person: string) => composeRuntime({ services: { state, artifacts, clock, ids, digester, tools: [], planner: new ScriptedPlanner([]), sink: new FakeSink() },
    board: { repository, workSources, actors: { current: async () => structuredClone(actors[person]!) }, authority: { resolve: async identity => {
      const actor = Object.values(actors).find(value => value.tenantId === identity.tenantId && value.principalId === identity.principalId);
      if (!actor) return null;
      const { canManageBoards: _manage, ...trusted } = actor; return structuredClone(trusted);
    } } }, schemas: new AjvSchemas(), guidanceSource: { list: async () => [], read: async () => { throw new Error('unused'); } },
    owner: `worker-${person}`, leaseMs: 10000, enablePlanning: false });
  for (const person of ['a', 'b']) {
    const work = initial(`work-${person}`); work.policy.principalId = `person-${person}`; work.policy.allowWrites = true;
    work.policy.allowedTools = [...BOARD_WRITE_TOOLS, ...BOARD_REQUEST_TOOLS, BOARD_READ_TOOL, BOARD_REQUEST_READ_TOOL];
    work.budget.limits.replans = 50; work.budget.limits.toolCalls = 50;
    const artifact = await artifacts.put(new TextEncoder().encode(`original-${family}-${person}`), { tenantId: 'tenant-a', labels: ['synthetic'], mediaType: 'text/plain' });
    work.artifacts.push(artifact); work.evidence.push({ id: 'e1', tenantId: 'tenant-a', scope: 'fixture', sourceId: `${family}-${person}`, lineageId: `${family}-${person}`,
      locator: `fixture://${family}/${person}`, observedAt: 1000, recordedAt: 1001, labels: ['synthetic'], coverage: 'complete', status: 'accepted',
      derivedFrom: [], supersedes: [], facts: { value: family === 'documents' ? '30 days' : 'normal' }, artifact });
    await state.commit(command(work, `seed-${person}`));
  }
  let a = await compose('a'), b = await compose('b'); const bundle = (person: string) => person === 'a' ? a : b;
  const registerSources = () => { registrations.forEach(remove => remove());
    registrations = ['a', 'b'].map(person => workSources.register(actors[person]!, bundle(person).boardWorkSource!)); };
  registerSources();
  await a.board!.create({ id: 'board', commandId: 'create', namespace: 'team', scope: 'fixture', labels: ['synthetic'],
    roles: ['a', 'b'].map(person => ({ id: `role-${person}`, principalId: `person-${person}`, purpose: 'Collaborate', active: true })),
    limits: { maxPosts: 20, maxReplies: 5, maxUnproductiveReplies: 3, maxRequests: 5 } });
  await a.board!.addEntity({ boardId: 'board', commandId: 'entity', expectedRevision: 1,
    entity: { id: 'entity', authority: 'fixture', key: family, kind: family, title: family, validFrom: 0, validThrough: null } });
  const mutation = async () => ({ boardId: 'board', expectedRevision: (await repository.get('tenant-a', 'board'))!.revision });
  const refresh = async (person: string) => bundle(person).services.effects!.refresh(`work-${person}`);
  const prepare = async (person: string, toolId: string, input: TaskSpec['input']) => {
    await refresh(person);
    const current = await bundle(person).runtime.budgets.prepare(`work-${person}`); const task: TaskSpec = { id: `task-${++sequence}`, description: 'Collaborate', toolId, toolVersion: '1',
      effect: [BOARD_READ_TOOL, BOARD_REQUEST_READ_TOOL].includes(toolId) ? 'read' : 'write', input, maxAttempts: 1, dependsOn: [], satisfies: [] };
    await bundle(person).runtime.submitPlan(current.id, `plan-${sequence}`, { baseStateRevision: current.revision, baseGoalRevision: current.goal.revision,
      basePlanRevision: current.plan?.revision ?? 0, tasks: [task], hypotheses: [], reason: 'Exercise request lifecycle' });
    return { task, attempt: await bundle(person).runtime.reserve(current.id, task.id) };
  };
  const execute = async (person: string, toolId: string, input: TaskSpec['input']) => {
    const pending = await prepare(person, toolId, input), runtime = bundle(person).runtime;
    await runtime.execute(`work-${person}`, pending.attempt.id); await runtime.settlePending(pending.attempt.id); await runtime.adopt(`work-${person}`, pending.attempt.id);
    const current = await refresh(person), attempt = current.attempts.find(value => value.id === pending.attempt.id)!;
    const result = attempt.resultArtifact ? ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await artifacts.get(attempt.resultArtifact, current.policy)))) : null;
    assert.equal(attempt.adopted, true, JSON.stringify({ attempt, result }));
    return { ...pending, state: current, attempt, result };
  };
  const publish = async (person: string, id: string, answer = false) => execute(person, BOARD_WRITE_TOOLS[0], { ...await mutation(), id, entityId: 'entity',
    kind: answer ? 'observation' : 'question', body: answer ? 'Evidence-backed answer' : 'Please examine the evidence', labels: [],
    evidenceIds: answer ? ['e1'] : [], quotedPostIds: [], replyTo: answer ? 'question' : null, relation: answer ? 'clarifies' : null, causeId: id, expiresAt: null });
  const read = (person: string) => execute(person, BOARD_READ_TOOL, { boardId: 'board', maxPosts: 20, maxBytes: 32768 });
  const readRequests = async (person: string, requestId?: string) => {
    const result = await execute(person, BOARD_REQUEST_READ_TOOL, { boardId: 'board', maxRequests: 20, maxBytes: 32768, ...(requestId ? { requestId } : {}) });
    return { ...result, page: BoardRequestPageSchema.parse(result.result!.output) };
  };
  const offer = async () => { await publish('a', 'question'); return execute('a', BOARD_REQUEST_TOOLS[0], { ...await mutation(), id: 'request', questionId: 'question', toAgentId: 'role-b', deliverable: 'Cited answer', dueAt: 50000 }); };
  const accept = async () => { await read('b'); return execute('b', BOARD_REQUEST_TOOLS[1], { ...await mutation(), requestId: 'request' }); };
  const answer = async () => { await publish('b', 'answer', true); return execute('b', BOARD_REQUEST_TOOLS[2], { ...await mutation(), requestId: 'request', postId: 'answer' }); };
  const confirm = async () => { await read('a'); return execute('a', BOARD_REQUEST_TOOLS[3], { ...await mutation(), requestId: 'request' }); };
  const edit = async (person: string, change: (work: WorkState) => void) => { const next = advance((await state.get(`work-${person}`))!); change(next); await state.commit(command(next, `edit-${++sequence}`)); };
  const reopen = async () => { registrations.forEach(remove => remove()); await state.close(); await repository.close(); state = openRepository(adapter, directory); repository = openBoard(); a = await compose('a'); b = await compose('b'); registerSources(); };
  t.after(async () => { registrations.forEach(remove => remove()); await state.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); });
  return { get state() { return state; }, get repository() { return repository; }, bundle, clock, directory, artifacts, actors, mutation, prepare, execute, publish, read, readRequests, offer, accept, answer, confirm, refresh, edit, reopen };
}
