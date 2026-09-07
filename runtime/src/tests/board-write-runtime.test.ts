import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { composeRuntime } from '../application/compose-runtime.js';
import { BOARD_WRITE_TOOLS } from '../application/board-commands.js';
import { BOARD_READ_TOOL } from '../application/board-tools.js';
import { ToolResultSchema } from '../application/contracts.js';
import { buildModelContextPacket } from '../application/context-packet.js';
import { effectProofsCurrent, refreshEffectProofs } from '../application/effect-proofs.js';
import type { BoardRepository } from '../application/board-ports.js';
import type { BoardActor } from '../domain/board.js';
import type { TaskSpec, WorkState } from '../domain/model.js';
import { FileBoardRepository } from '../infrastructure/file-board.js';
import { SqliteBoardRepository } from '../infrastructure/sqlite-board.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { FakeClock, FakeSink, ScriptedPlanner, SequenceIds } from '../infrastructure/fakes.js';
import { advance, command, initial, openRepository, type Adapter } from './state-conformance-helpers.js';

async function fixture(t: TestContext, adapter: Adapter, separateAuthority = false) {
  const directory = await mkdtemp(join(tmpdir(), 'secumon-board-write-'));
  let state = openRepository(adapter, directory);
  const openBoard = (): BoardRepository => adapter === 'sqlite' ? new SqliteBoardRepository(join(directory, 'board.sqlite')) : new FileBoardRepository(join(directory, 'boards'));
  let repository = openBoard(); const artifacts = new FileArtifactStore(join(directory, 'artifacts'));
  const actor: BoardActor = { tenantId: 'tenant-a', principalId: 'person-a', allowedScopes: ['fixture'], allowedNamespaces: ['team'],
    allowedLabels: ['synthetic'], canManageBoards: true, canPublish: true, canReview: false };
  const clock = new FakeClock(1100), ids = new SequenceIds(), digester = new Sha256Digester(); let sequence = 0;
  const actors = { current: async () => structuredClone(actor) };
  const directoryActor = separateAuthority ? structuredClone(actor) : actor;
  const authority = { resolve: async () => { const { canManageBoards: _manage, ...value } = directoryActor; return structuredClone(value); } };
  const compose = () => composeRuntime({ services: { state, artifacts, clock, ids, digester, tools: [], planner: new ScriptedPlanner([]), sink: new FakeSink() },
    board: { repository, actors, authority }, schemas: new AjvSchemas(), guidanceSource: { list: async () => [], read: async () => { throw new Error('unused'); } },
    owner: 'worker', leaseMs: 10000, enablePlanning: false });
  const work = initial('writer'); work.policy.allowedTools = [...BOARD_WRITE_TOOLS, BOARD_READ_TOOL]; work.policy.allowWrites = true;
  await state.commit(command(work, 'seed'));
  let bundle = await compose();
  await bundle.board!.create({ id: 'board', commandId: 'create', namespace: 'team', scope: 'fixture', labels: ['synthetic'],
    roles: [{ id: 'role', principalId: actor.principalId, purpose: 'Generic discussion', active: true }],
    limits: { maxPosts: 20, maxReplies: 5, maxUnproductiveReplies: 3, maxRequests: 5 } });
  await bundle.board!.addEntity({ boardId: 'board', commandId: 'entity', expectedRevision: 1,
    entity: { id: 'entity', authority: 'fixture', key: 'record', kind: 'document', title: 'Document', validFrom: 0, validThrough: null } });
  const input = async (postId = 'post'): Promise<TaskSpec['input']> => ({ boardId: 'board', expectedRevision: (await repository.get(actor.tenantId, 'board'))!.revision,
    id: postId, entityId: 'entity', kind: 'hypothesis', body: 'A hypothesis requiring verification', labels: [], evidenceIds: [], quotedPostIds: [],
    replyTo: null, relation: null, causeId: postId, expiresAt: null });
  const prepare = async (value?: TaskSpec['input'], toolId: string = BOARD_WRITE_TOOLS[0]) => {
    value ??= await input();
    const current = (await state.get('writer'))!;
    const task: TaskSpec = { id: `task-${++sequence}`, description: 'Publish a discussion', toolId, toolVersion: '1', effect: toolId === BOARD_READ_TOOL ? 'read' : 'write',
      input: value, maxAttempts: 1, dependsOn: [], satisfies: [] };
    await bundle.runtime.submitPlan('writer', `plan-${sequence}`, { baseStateRevision: current.revision, baseGoalRevision: current.goal.revision,
      basePlanRevision: current.plan?.revision ?? 0, tasks: [task], hypotheses: [], reason: 'Exercise local durable discussion' });
    const attempt = await bundle.runtime.reserve('writer', task.id);
    return { task, attempt };
  };
  const execute = async (value?: TaskSpec['input'], toolId: string = BOARD_WRITE_TOOLS[0]) => {
    const pending = await prepare(value, toolId); await bundle.runtime.execute('writer', pending.attempt.id); await bundle.runtime.settlePending(pending.attempt.id); await bundle.runtime.adopt('writer', pending.attempt.id);
    const current = (await state.get('writer'))!, attempt = current.attempts.find(value => value.id === pending.attempt.id)!;
    const result = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await artifacts.get(attempt.resultArtifact!, current.policy))));
    return { ...pending, state: current, attempt, result };
  };
  const invoke = async (pending: Awaited<ReturnType<typeof prepare>>) => {
    await bundle.runtime.dispatch('writer', pending.attempt.id);
    const current = (await state.get('writer'))!;
    return bundle.services.tools.find(tool => tool.definition.id === pending.task.toolId)!.execute(pending.task,
      { workId: 'writer', attemptId: pending.attempt.id, policy: current.policy, signal: new AbortController().signal });
  };
  const edit = async (change: (work: WorkState) => void) => { const next = advance((await state.get('writer'))!); change(next); await state.commit(command(next, `edit-${++sequence}`)); };
  const reopen = async () => { await state.close(); await repository.close(); state = openRepository(adapter, directory); repository = openBoard(); bundle = await compose(); };
  t.after(async () => { await state.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); });
  return { get bundle() { return bundle; }, get state() { return state; }, get repository() { return repository; }, actor, clock, digester, artifacts,
    directory, input, prepare, execute, invoke, edit, reopen };
}

for (const adapter of ['sqlite', 'file-journal'] as const) {
  test(`${adapter}: board publish and retract run through the broker and retain mechanical receipts`, async t => {
    const h = await fixture(t, adapter), published = await h.execute();
    assert.equal(published.attempt.adopted, true, JSON.stringify(published)); assert.equal(published.attempt.effectReceipt?.outcome, 'applied');
    assert.deepEqual(published.result.evidence, []); assert.equal(published.state.evidence.length, 0);
    assert.equal(await effectProofsCurrent(h.bundle.services, published.state), true); assert.notEqual(published.state.status, 'completed');
    const retracted = await h.execute({ boardId: 'board', expectedRevision: 3, postId: 'post' }, BOARD_WRITE_TOOLS[1]);
    assert.equal(retracted.attempt.adopted, true, JSON.stringify(retracted));
    assert.equal((await h.repository.get('tenant-a', 'board'))!.posts[0]!.status, 'retracted');
    assert.equal(await effectProofsCurrent(h.bundle.services, retracted.state), true, 'later retraction does not erase the earlier applied receipt');
    assert.equal(retracted.state.budget.used.toolCalls, 2); assert.equal(retracted.state.budget.used.modelCalls, 0);
    const frame = await h.bundle.context.prepare(retracted.state, { callId: 'compact', maxInputBytes: 500000, maxInputTokens: 600000, maxOutputTokens: 1000, forceCompact: true });
    assert.equal(frame.packet.execution!.attempts.filter(attempt => attempt.effectReceipt).length, 2);
    await h.reopen(); const recovered = await h.bundle.recovery.restore('writer', h.actor);
    assert.equal(recovered.packet.runtime.attempts.filter(attempt => attempt.effectReceipt).length, 2);
  });
  test(`${adapter}: applied board command survives response loss and cannot be overwritten by the late result`, async t => {
    const h = await fixture(t, adapter), pending = await h.prepare(), result = await h.invoke(pending);
    assert.equal(result.status, 'success'); h.clock.advance(20000); await h.reopen();
    const state = await h.bundle.runtime.recover('writer', pending.attempt.id), attempt = state.attempts[0]!;
    assert.equal(attempt.effectReceipt?.outcome, 'applied'); assert.equal(attempt.effectReceipt?.origin, 'reconciliation');
    assert.equal(attempt.resultArtifact, null); assert.equal(attempt.adopted, false); assert.equal(attempt.effectState, 'confirmed');
    assert.equal(state.obligations.find(value => value.id === `effect:${attempt.id}`)?.status, 'satisfied');
    await h.bundle.runtime.receive('writer', attempt.id, result);
    assert.equal((await h.state.get('writer'))!.attempts[0]!.resultArtifact, null);
    assert.equal((await h.repository.get('tenant-a', 'board'))!.posts.length, 1);
    assert.notEqual((await h.bundle.runtime.step('writer')).kind, 'complete');
    const packet = await buildModelContextPacket((await h.state.get('writer'))!, h.bundle.contracts, h.bundle.services);
    assert.equal(packet.execution!.attempts[0]!.effectReceipt?.outcome, 'applied');
  });
  test(`${adapter}: saved unknown result stays immutable after durable receipt reconciliation`, async t => {
    const h = await fixture(t, adapter), original = h.repository.commit.bind(h.repository);
    h.repository.commit = async command => { const value = await original(command); if (command.commandId.startsWith('board:')) throw new Error('response_lost'); return value; };
    const executed = await h.execute(); assert.equal(executed.attempt.status, 'unknown');
    h.repository.commit = original;
    const state = await h.bundle.services.effects!.refresh('writer'), attempt = state.attempts[0]!;
    assert.equal(attempt.effectReceipt?.outcome, 'applied'); assert.deepEqual(attempt.resultArtifact, executed.attempt.resultArtifact);
    assert.equal(attempt.resultId, executed.attempt.resultId); assert.equal(attempt.adopted, false);
    const raw = ToolResultSchema.parse(JSON.parse(new TextDecoder().decode(await h.artifacts.get(attempt.resultArtifact!, state.policy))));
    assert.equal(raw.effectState, 'unknown'); assert.equal(raw.status, 'error');
  });
  test(`${adapter}: a late valid result is reconciled without adopting its expired execution`, async t => {
    const h = await fixture(t, adapter), pending = await h.prepare(), result = await h.invoke(pending);
    h.clock.advance(20000); await h.bundle.runtime.receive('writer', pending.attempt.id, result); await h.bundle.runtime.adopt('writer', pending.attempt.id);
    const prior = (await h.state.get('writer'))!;
    assert.equal(prior.attempts[0]!.effectReceipt?.origin, 'execution'); assert.equal(prior.attempts[0]!.adopted, false);
    const state = await h.bundle.services.effects!.refresh('writer');
    assert.equal(state.attempts[0]!.effectReceipt?.origin, 'reconciliation');
    assert.equal(state.obligations.find(value => value.id === `effect:${pending.attempt.id}`)?.status, 'satisfied');
    assert.equal(state.attempts[0]!.adopted, false); assert.deepEqual(state.attempts[0]!.resultArtifact, prior.attempts[0]!.resultArtifact);
    assert.deepEqual(state.attempts[0]!.effectReceipt!.artifact, prior.attempts[0]!.effectReceipt!.artifact);
  });
  test(`${adapter}: an expired absent command is closed and a delayed original commit cannot publish`, async t => {
    const h = await fixture(t, adapter), pending = await h.prepare(), original = h.repository.commit.bind(h.repository);
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { entered = resolve; }); const resume = new Promise<void>(resolve => { release = resolve; });
    h.repository.commit = async command => { if (command.commandId.startsWith('board:') && !command.disposition) { entered(); await resume; } return original(command); };
    const running = h.invoke(pending); await blocked;
    const live = await h.bundle.boardCommands!.reconcile('writer', pending.attempt.id);
    assert.equal(live.attempts[0]!.effectReceipt, undefined, 'live invocation is not closed');
    h.clock.advance(20000); const recovered = await h.bundle.runtime.recover('writer', pending.attempt.id);
    assert.equal(recovered.attempts[0]!.effectReceipt?.outcome, 'not_applied'); release();
    assert.equal((await running).status, 'error'); assert.equal((await h.repository.get('tenant-a', 'board'))!.posts.length, 0);
    await h.reopen(); assert.equal(await effectProofsCurrent(h.bundle.services, (await h.state.get('writer'))!), true);
  });
  test(`${adapter}: stale revision is reconciled as closed without changing posts`, async t => {
    const h = await fixture(t, adapter), input = await h.input() as Record<string, unknown>;
    const executed = await h.execute({ ...input, expectedRevision: 1 } as TaskSpec['input']);
    assert.equal(executed.attempt.effectState, 'unknown');
    const state = await h.bundle.services.effects!.refresh('writer'); assert.equal(state.attempts[0]!.effectReceipt?.outcome, 'not_applied');
    assert.equal((await h.repository.get('tenant-a', 'board'))!.posts.length, 0);
    const receipt = state.attempts[0]!.effectReceipt!;
    assert.equal((await h.repository.receipt('tenant-a', 'board', receipt.operationId))!.disposition, 'not_applied');
  });
  test(`${adapter}: proof deletion denies context, reopens obligation and does not fabricate replacement`, async t => {
    const h = await fixture(t, adapter), executed = await h.execute();
    await unlink(join(h.directory, 'artifacts', `${executed.attempt.effectReceipt!.artifact.id}.blob`));
    assert.equal(await effectProofsCurrent(h.bundle.services, executed.state), false);
    await assert.rejects(buildModelContextPacket(executed.state, h.bundle.contracts, h.bundle.services));
    const state = await h.bundle.services.effects!.refresh('writer');
    assert.equal(state.attempts[0]!.adopted, false); assert.equal(state.attempts[0]!.effectState, 'unknown');
    assert.equal(state.obligations.find(value => value.id === `effect:${executed.attempt.id}`)?.status, 'pending');
    await assert.rejects(h.bundle.recovery.restore('writer', h.actor));
  });
  test(`${adapter}: retained receipt requires a reader and current role authority`, async t => {
    const h = await fixture(t, adapter), executed = await h.execute();
    assert.equal(await effectProofsCurrent({}, executed.state), false);
    await assert.rejects(refreshEffectProofs({ ...h.bundle.services, effects: undefined }, 'writer'), /effect_receipt_reader_unavailable/);
    h.actor.allowedNamespaces = [];
    assert.equal(await effectProofsCurrent(h.bundle.services, executed.state), false);
    await assert.rejects(buildModelContextPacket(executed.state, h.bundle.contracts, h.bundle.services));
  });
  test(`${adapter}: authority withdrawn during receipt proof I/O invalidates that same read`, async t => {
    const h = await fixture(t, adapter), executed = await h.execute(), get = h.artifacts.get.bind(h.artifacts);
    h.artifacts.get = async (ref, policy) => { const bytes = await get(ref, policy);
      if (ref.id === executed.attempt.effectReceipt!.artifact.id) h.actor.allowedNamespaces = [];
      return bytes;
    };
    assert.equal(await effectProofsCurrent(h.bundle.services, executed.state), false);
  });
  test(`${adapter}: removing the stored receipt invalidates an intact result artifact`, async t => {
    const h = await fixture(t, adapter), executed = await h.execute(), read = h.repository.receipt.bind(h.repository);
    h.repository.receipt = async (tenant, board, commandId) => commandId.startsWith('board:') ? null : read(tenant, board, commandId);
    assert.equal(await h.bundle.boardCommands!.verify(executed.state, executed.attempt.id, executed.attempt.effectReceipt!), false);
    assert.equal(await h.bundle.contracts.validateResult(executed.state, executed.result), false);
  });
  test(`${adapter}: a forged post outcome or another attempt receipt cannot be adopted`, async t => {
    const h = await fixture(t, adapter), pending = await h.prepare(), result = await h.invoke(pending);
    assert.equal(await h.bundle.contracts.validateResult((await h.state.get('writer'))!, { ...result, output: { boardId: 'board', postId: 'other', status: 'published' } }), false);
    assert.equal(await h.bundle.boardCommands!.verify((await h.state.get('writer'))!, pending.attempt.id, { ...result.effectReceipt!, operationId: 'different' }), false);
    assert.equal(await h.bundle.boardCommands!.verify((await h.state.get('writer'))!, 'foreign-attempt', result.effectReceipt!), false);
  });
  test(`${adapter}: policy revoked immediately before storage prevents publication`, async t => {
    const h = await fixture(t, adapter), pending = await h.prepare(); await h.bundle.runtime.dispatch('writer', pending.attempt.id);
    let checked = 0;
    const tool = h.bundle.services.tools.find(value => value.definition.id === BOARD_WRITE_TOOLS[0])!;
    const result = await tool.execute(pending.task, { workId: 'writer', attemptId: pending.attempt.id, policy: (await h.state.get('writer'))!.policy,
      signal: new AbortController().signal, authorize: async () => { if (++checked === 2) await h.edit(work => { work.policy.allowWrites = false; }); } });
    assert.equal(result.status, 'error'); assert.equal((await h.repository.get('tenant-a', 'board'))!.posts.length, 0);
  });
  test(`${adapter}: tool schemas exclude actor, command identity and foreign source work`, async t => {
    const h = await fixture(t, adapter), input = await h.input() as Record<string, unknown>;
    for (const extra of [{ workId: 'foreign' }, { commandId: 'caller' }, { actor: { canPublish: true } }, { sources: [{ workId: 'foreign', evidenceId: 'e' }] }])
      await assert.rejects(h.prepare({ ...input, ...extra } as TaskSpec['input']));
  });
  for (const restriction of ['publish', 'namespace'] as const) test(`${adapter}: a narrower session ${restriction} grant is not widened by the directory`, async t => {
    const h = await fixture(t, adapter, true);
    if (restriction === 'publish') h.actor.canPublish = false; else h.actor.allowedNamespaces = [];
    const result = await h.execute(); assert.equal(result.attempt.adopted, false);
    assert.equal((await h.repository.get('tenant-a', 'board'))!.posts.length, 0);
  });
  test(`${adapter}: a no-op closure cannot smuggle a board mutation`, async t => {
    const h = await fixture(t, adapter), board = (await h.repository.get('tenant-a', 'board'))!, next = structuredClone(board);
    next.revision++; next.updatedAt++; next.roles[0]!.active = false;
    await assert.rejects(h.repository.commit({ expectedRevision: board.revision, next, commandId: 'closed-invalid', commandDigest: 'a'.repeat(64), disposition: 'not_applied' }), /board_rejection_must_be_noop/);
    assert.equal((await h.repository.get('tenant-a', 'board'))!.revision, board.revision);
  });
  test(`${adapter}: closure duplicate and changed digest have stable distinct outcomes`, async t => {
    const h = await fixture(t, adapter), board = (await h.repository.get('tenant-a', 'board'))!, next = structuredClone(board);
    next.revision++; next.updatedAt++;
    const command = { expectedRevision: board.revision, next, commandId: 'closed', commandDigest: 'a'.repeat(64), disposition: 'not_applied' as const };
    assert.equal((await h.repository.commit(command)).kind, 'not_applied');
    assert.equal((await h.repository.commit({ ...command, disposition: undefined })).kind, 'not_applied');
    assert.equal((await h.repository.commit({ ...command, commandDigest: 'b'.repeat(64) })).kind, 'idempotency_conflict');
    await h.reopen(); assert.equal((await h.repository.receipt('tenant-a', 'board', 'closed'))?.disposition, 'not_applied');
  });
  test(`${adapter}: previously unread quotes are rejected and a retained current read permits publication`, async t => {
    const h = await fixture(t, adapter);
    await h.bundle.board!.publish({ boardId: 'board', expectedRevision: 2, commandId: 'seed-post', id: 'parent', workId: 'writer', entityId: 'entity', kind: 'hypothesis',
      body: 'Unverified parent', labels: [], sources: [], quotedPostIds: [], replyTo: null, relation: null, causeId: 'parent', expiresAt: null });
    const input = await h.input('reply') as Record<string, unknown>;
    const rejected = await h.execute({ ...input, quotedPostIds: ['parent'] } as TaskSpec['input']); assert.equal(rejected.attempt.adopted, false);
    await h.bundle.services.effects!.refresh('writer');
    const read = await h.execute({ boardId: 'board', maxPosts: 20, maxBytes: 32768 }, BOARD_READ_TOOL); assert.equal(read.attempt.adopted, true);
    const published = await h.execute({ ...await h.input('reply') as Record<string, unknown>, quotedPostIds: ['parent'] } as TaskSpec['input']);
    assert.equal(published.attempt.adopted, true, JSON.stringify(published.result));
    assert.equal(await h.bundle.services.inputs!.current(published.state), true);
  });
  test(`${adapter}: compact source checks reject omitted or altered effect outcomes`, async t => {
    const h = await fixture(t, adapter), executed = await h.execute();
    const frame = await h.bundle.context.prepare(executed.state, { callId: 'receipt-context', maxInputBytes: 500000, maxInputTokens: 600000, maxOutputTokens: 1000, forceCompact: true });
    const current = (await h.state.get('writer'))!;
    const altered = structuredClone(frame.packet); altered.execution!.attempts[0]!.effectReceipt!.outcome = 'not_applied';
    assert.equal(await h.bundle.context.sourcesCurrent(altered, current), false);
    const omitted = structuredClone(frame.packet); omitted.execution!.attempts = [];
    assert.equal(await h.bundle.context.sourcesCurrent(omitted, current), false);
  });
  test(`${adapter}: a SIGKILL at the storage-worker boundary retains the runtime command receipt`, { timeout: 15000 }, async t => {
    const h = await fixture(t, adapter), original = h.repository.commit.bind(h.repository);
    const child = fork(new URL('./helpers/board-worker.js', import.meta.url), [adapter, h.directory], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    h.repository.commit = async command => {
      if (!command.commandId.startsWith('board:')) return original(command);
      const ready = new Promise<{ kind: string; pid: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('board_worker_timeout')), 5000);
        child.once('message', value => { clearTimeout(timer); resolve(value as { kind: string; pid: number }); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
      });
      child.send(command); const result = await ready; assert.equal(result.kind, 'committed');
      const stopped = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('board_worker_exit_timeout')), 5000);
        child.once('exit', (_code, signal) => { clearTimeout(timer); if (signal !== 'SIGKILL') reject(new Error('unexpected_exit')); else resolve(); });
      });
      child.kill('SIGKILL'); await stopped;
      assert.throws(() => process.kill(result.pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
      throw new Error('storage_reply_lost');
    };
    const executed = await h.execute(); assert.equal(executed.attempt.status, 'unknown');
    await h.reopen(); const state = await h.bundle.services.effects!.refresh('writer');
    assert.equal(state.attempts[0]!.effectReceipt?.outcome, 'applied'); assert.equal(state.attempts[0]!.adopted, false);
    assert.deepEqual(state.attempts[0]!.resultArtifact, executed.attempt.resultArtifact);
    assert.equal((await h.repository.get('tenant-a', 'board'))!.posts.length, 1);
  });
}
