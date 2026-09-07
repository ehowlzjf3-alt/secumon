import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ArtifactStore } from '../application/ports.js';
import type { TaskSpec } from '../domain/model.js';
import { accessibleEvidence } from '../domain/completion.js';
import { validateScenario } from '../application/fixtures.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { DataLifecycleService } from '../application/data-lifecycle.js';
import { ContextRecovery } from '../application/context-recovery.js';
import { WorkResources } from '../application/work-resources.js';
import { transact } from '../application/work-transactions.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { FileGuidanceSource } from '../infrastructure/file-guidance.js';
import { FakeClock, FakeSink, FixtureReadTool, ScriptedPlanner } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { adapters, openRepository, type Adapter } from './state-conformance-helpers.js';
import { RESOURCE_TOOL_IDS } from '../application/resource-tools.js';

const actor = { tenantId: 'synthetic', principalId: 'learner' };
const marker = 'SENSITIVE_FIXTURE_CONTENT';
async function setup(adapter: Adapter, family = 'documents-simple') {
  const dir = await mkdtemp(join(tmpdir(), 'data-lifecycle-'));
  const scenario = validateScenario(JSON.parse(readFileSync(new URL(`../../fixtures/${family}.json`, import.meta.url), 'utf8')));
  const source = structuredClone(scenario.evidence.find(e => e.id === (family === 'documents-simple' ? 'doc-current' : 'collection-complete'))!); const backing = new FileArtifactStore(join(dir, 'artifacts'));
  source.artifact = await backing.put(new TextEncoder().encode(marker), { tenantId: actor.tenantId, labels: source.labels, mediaType: 'text/plain' });
  source.facts['marker'] = marker; source.locator = marker;
  const tool = new FixtureReadTool([source]); const planner = new ScriptedPlanner([]);
  const state = openRepository(adapter, dir); const sink = new FakeSink();
  const services = { state, artifacts: backing, planner, tools: [tool], sink, clock: new FakeClock(1788566400000), ids: new RandomIds(), digester: new Sha256Digester() };
  const composed = await composeRuntime({ services, schemas: new AjvSchemas(), guidanceSource: new FileGuidanceSource(new URL('../../guidance', import.meta.url).pathname), owner: 'owner' });
  const accepted = await composed.conversation.accept(actor, { messageId: 'lifecycle', binding: { ...actor, channel: 'test', conversationId: 'lifecycle', recipientId: actor.principalId, destination: 'local' },
    goal: scenario.goal, policy: { ...scenario.policy, allowedTools: [...scenario.policy.allowedTools, ...RESOURCE_TOOL_IDS] }, limits: { toolCalls: 20, modelCalls: 10, tokens: 1000000, replans: 5, wallTimeMs: 1000000 }, completionRequiresDelivery: true });
  const workId = accepted.workId;
  const task = (id: string, toolId = 'fixture.read', input: TaskSpec['input'] = { evidenceIds: [source.id] }): TaskSpec => ({ id, description: 'Synthetic read', toolId, toolVersion: '1', input, dependsOn: [], effect: 'read', maxAttempts: 2, satisfies: [] });
  const plan = async (selected: TaskSpec) => {
    const state = await composed.runtime.state(workId);
    return composed.runtime.submitPlan(workId, `plan:${selected.id}`, { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision, basePlanRevision: state.plan?.revision ?? 0, reason: 'Explicit fixture plan', tasks: [selected], hypotheses: [] });
  };
  const collect = async () => { await plan(task('source')); const attempt = await composed.runtime.reserve(workId, 'source'); await composed.runtime.execute(workId, attempt.id); await composed.runtime.adopt(workId, attempt.id); return attempt.id; };
  const change = (action: 'delete' | 'restrict' | 'retract', commandId = 'change', expectedGeneration = 0) => composed.dataLifecycle.change(workId, actor, commandId, { action, evidenceIds: [source.id], expectedGeneration, reason: 'Synthetic lifecycle check', replacement: null });
  let closed = false; const closeState = async () => { if (!closed) { await state.close(); closed = true; } };
  return { ...composed, services, backing, dir, source, workId, task, plan, collect, change, closeState, close: async () => { await closeState(); await rm(dir, { recursive: true, force: true }); } };
}

for (const adapter of adapters) for (const family of ['documents-simple', 'observations-simple']) {
  test(`${adapter}/${family}: delete blocks derived copies and pending result; restart preserves tombstone and cancellation works after bytes are absent`, async () => {
    const f = await setup(adapter, family); let reopened: ReturnType<typeof openRepository> | undefined;
    try {
      const attemptId = await f.collect(); const delivery = await f.conversation.prepare(f.workId, actor); assert.equal(delivery?.kind, 'result');
      const checkpoint = await f.recovery.restore(f.workId, actor);
      assert.equal((await f.resources.original(f.workId, actor, f.source.id, 65536)).status, 'available');
      const change = await f.change('delete'); assert.equal(change.generation, 1); assert.equal(change.purge, 'pending_retention_review');
      assert.equal((await f.change('delete')).changed, false);
      await assert.rejects(f.change('restrict', 'other', 0), /stale_data_generation/);
      await assert.rejects(f.resources.original(f.workId, actor, f.source.id, 65536), /evidence_unavailable/);
      await assert.rejects(f.resources.result(f.workId, actor, attemptId, 65536), /invocation_unavailable/);
      await f.outbox.flush(f.workId, actor);
      assert.equal([...f.services.sink.delivered.values()].filter(d => d.kind === 'result').length, 0);
      assert.equal((await f.services.state.deliveries(f.workId)).find(d => d.id === delivery!.id)!.status, 'superseded');
      assert.equal((await f.conversation.snapshot(f.workId, actor)).resultReady, false);
      await rm(join(f.dir, 'artifacts', `${f.source.artifact!.id}.blob`));
      await f.closeState(); reopened = openRepository(adapter, f.dir);
      const services = { ...f.services, state: reopened };
      const after = await new ContextRecovery(services, f.contracts).restore(f.workId, actor, checkpoint.artifact);
      assert.equal(after.disposition, 'regenerated'); assert.equal(JSON.stringify(after.packet).includes(marker), false);
      assert.equal(after.packet.runtime.status, 'blocked'); assert.equal(after.packet.runtime.dataLifecycle!.changes[0]!.purge, 'pending_retention_review');
      const again = await new DataLifecycleService(services).change(f.workId, actor, 'change', { action: 'delete', evidenceIds: [f.source.id], expectedGeneration: 0, reason: 'Synthetic lifecycle check', replacement: null });
      assert.equal(again.changed, false);
      const { ExecutionRuntime } = await import('../application/execution-runtime.js');
      const execution = new ExecutionRuntime(services, f.contracts, 'after');
      assert.equal((await execution.command(f.workId, 'cancel', actor, 1, { kind: 'cancel', reason: 'stop' })).status, 'cancelled');
    } finally { await reopened?.close(); await f.close(); }
  });
}

for (const adapter of adapters) {
  test(`${adapter}: lifecycle ownership, concurrent generation and command identity are enforced`, async () => {
    const f = await setup(adapter);
    try {
      await f.collect(); const revision = (await f.runtime.state(f.workId)).revision;
      const input = { action: 'restrict' as const, evidenceIds: [f.source.id], expectedGeneration: 0, reason: 'Owner request', replacement: null };
      await assert.rejects(f.dataLifecycle.change(f.workId, { ...actor, principalId: 'other' }, 'forbidden', input), /work_unavailable/);
      await assert.rejects(f.dataLifecycle.change(f.workId, { ...actor, allowWrites: false }, 'forbidden', input), /data_change_not_authorized/);
      assert.equal((await f.runtime.state(f.workId)).revision, revision);
      const outcomes = await Promise.allSettled(['a', 'b'].map(id => f.dataLifecycle.change(f.workId, actor, id, input)));
      assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
      const rejected = outcomes.find(o => o.status === 'rejected') as PromiseRejectedResult;
      assert.match(String(rejected.reason), /stale_data_generation/);
      const winner = outcomes[0]!.status === 'fulfilled' ? 'a' : 'b';
      assert.equal((await f.dataLifecycle.change(f.workId, actor, winner, input)).changed, false);
      await assert.rejects(f.dataLifecycle.change(f.workId, actor, winner, { ...input, reason: 'Different command body' }), /idempotency_conflict/);
      assert.equal((await f.runtime.state(f.workId)).dataLifecycle!.generation, 1);
    } finally { await f.close(); }
  });

  test(`${adapter}: a question prepared before access removal is superseded without sending its text`, async () => {
    const f = await setup(adapter);
    try {
      await f.collect();
      await f.runtime.command(f.workId, 'wait', actor, 1, { kind: 'wait', obligation: { id: 'question', kind: 'response', reason: marker, status: 'pending', wakeKey: 'reply', dueAt: null } });
      const question = await f.conversation.prepare(f.workId, actor); assert.equal(question?.kind, 'question');
      await f.change('restrict'); await f.outbox.flush(f.workId, actor);
      assert.equal((await f.services.state.deliveries(f.workId)).find(d => d.id === question!.id)!.status, 'superseded');
      assert.equal(JSON.stringify([...f.services.sink.delivered.values()]).includes(marker), false);
      assert.equal(JSON.stringify(await f.conversation.snapshot(f.workId, actor)).includes(marker), false);
    } finally { await f.close(); }
  });

  test(`${adapter}: data removal preserves an already dispatched write as an unresolved effect`, async () => {
    const f = await setup(adapter);
    try {
      await f.collect();
      await transact(f.services, f.workId, 'synthetic-write', 'synthetic_dispatched_write', {}, state => {
        state.attempts.push({ id: 'unconfirmed-write', taskId: 'write', planRevision: 1, goalRevision: 1, toolId: 'synthetic.write', toolVersion: '1', inputDigest: 'synthetic', scope: state.goal.scope,
          effect: 'write', effectState: 'unknown', status: 'running', owner: 'owner', leaseUntil: state.deadlineAt, startedAt: f.services.clock.now(), finishedAt: null,
          resultId: null, resultArtifact: null, adopted: false, error: null });
        state.budget.used.toolCalls++; state.status = 'running';
      });
      await f.change('delete'); const state = await f.runtime.state(f.workId);
      assert.equal(state.attempts.find(a => a.id === 'unconfirmed-write')!.effectState, 'unknown');
      assert.equal(state.obligations.find(o => o.id === 'effect:unconfirmed-write')!.status, 'pending');
      assert.equal(state.budget.used.toolCalls, 2);
      await f.runtime.recover(f.workId, 'unconfirmed-write');
      assert.equal((await f.runtime.state(f.workId)).attempts.find(a => a.id === 'unconfirmed-write')!.status, 'unknown');
      assert.equal((await f.conversation.snapshot(f.workId, actor)).unresolvedEffects, 1);
    } finally { await f.close(); }
  });

  for (const kind of ['tool', 'model'] as const) test(`${adapter}: ${kind} reply is revalidated after lifecycle change during artifact storage`, async () => {
    const f = await setup(adapter);
    try {
      await transact(f.services, f.workId, 'seed', 'synthetic_seed', {}, state => { state.evidence.push(f.source); state.goal.criteria[0]!.key = 'missing'; });
      let hook = true;
      const artifacts: ArtifactStore = { get: (r, p) => f.backing.get(r, p), exists: r => f.backing.exists(r), async put(bytes, meta) {
        const ref = await f.backing.put(bytes, meta); if (hook) { hook = false; await f.change('delete'); } return ref;
      } };
      if (kind === 'tool') {
        await f.plan(f.task('source')); const attempt = await f.runtime.reserve(f.workId, 'source'); await f.runtime.dispatch(f.workId, attempt.id);
        const value = await f.services.tools[0]!.execute(f.task('source'), { workId: f.workId, attemptId: attempt.id, policy: (await f.runtime.state(f.workId)).policy, signal: new AbortController().signal });
        const { ExecutionRuntime } = await import('../application/execution-runtime.js');
        const execution = new ExecutionRuntime({ ...f.runtime.services, artifacts }, f.contracts, 'owner');
        await execution.receive(f.workId, attempt.id, value); const state = await f.runtime.state(f.workId);
        const stored = state.attempts.find(a => a.id === attempt.id)!;
        assert.equal(new TextDecoder().decode(await f.backing.get(stored.resultArtifact!, state.policy)).includes(marker), false);
        assert.equal(state.budget.used.toolCalls, 1);
      } else {
        const call = await f.planning!.reserve(f.workId); await f.planning!.dispatch(f.workId, call.id);
        const { PlanningRuntime } = await import('../application/planning-runtime.js');
        const planning = new PlanningRuntime({ ...f.planning!.services, artifacts }, f.contracts, f.runtime, 'owner');
        await planning.receive(f.workId, call.id, { status: 'ok', provider: 'scripted', model: 'fixture', inputTokens: 7, outputTokens: 3,
          proposal: { baseStateRevision: call.baseStateRevision, baseGoalRevision: 1, basePlanRevision: 0, reason: marker, tasks: [f.task('next')], hypotheses: [] } });
        const state = await f.runtime.state(f.workId);
        assert.equal(new TextDecoder().decode(await f.backing.get(state.modelCalls[0]!.replyArtifact!, state.policy)).includes(marker), false);
        assert.equal(state.budget.used.tokens, 10); assert.equal(state.budget.used.unmeasuredModelCalls, 0);
      }
      assert.equal(hook, false); assert.equal((await f.runtime.state(f.workId)).dataLifecycle!.generation, 1);
    } finally { await f.close(); }
  });

  test(`${adapter}: validity retraction allows labelled historical inspection and correction uses a new immutable evidence ID`, async () => {
    const f = await setup(adapter);
    try {
      const attemptId = await f.collect();
      const corrected = { ...f.source, id: 'corrected', supersedes: [f.source.id], recordedAt: f.source.recordedAt + 1, observedAt: f.source.observedAt + 1 };
      await f.dataLifecycle.change(f.workId, actor, 'correction', { action: 'correct', evidenceIds: [f.source.id], expectedGeneration: 0, reason: 'New source version', replacement: corrected });
      const state = await f.runtime.state(f.workId); assert.deepEqual(accessibleEvidence(state.evidence, state.policy, state.goal.scope).map(e => e.id), ['corrected']);
      const history = await f.resources.result(f.workId, actor, attemptId, 65536); assert.equal(history.status, 'available'); assert.equal(JSON.stringify(history).includes(marker), true);
      assert.equal(JSON.stringify(history).includes('"evidenceCurrent":false'), true);
      await f.dataLifecycle.change(f.workId, actor, 'retract-new', { action: 'retract', evidenceIds: ['corrected'], expectedGeneration: 1, reason: 'Not current', replacement: null });
      const after = await f.runtime.state(f.workId); assert.deepEqual(accessibleEvidence(after.evidence, after.policy, after.goal.scope), []);
      assert.equal(after.dataLifecycle!.changes.length, 2);
    } finally { await f.close(); }
  });

  test(`${adapter}: a stored core.calls.get copy cannot expose deleted source content`, async () => {
    const f = await setup(adapter);
    try {
      const sourceAttempt = await f.collect(); const state = await f.runtime.state(f.workId);
      await f.runtime.command(f.workId, 'goal', actor, 1, { kind: 'goal', expectedControlRevision: state.executionControl?.revision ?? 1, goal: { ...state.goal, revision: 2, criteria: [{ ...state.goal.criteria[0]!, key: 'not_yet_observed' }] } });
      await f.plan(f.task('copy', 'core.calls.get', { attemptId: sourceAttempt, maxBytes: 65536 }));
      const copied = await f.runtime.reserve(f.workId, 'copy'); await f.runtime.execute(f.workId, copied.id); await f.runtime.adopt(f.workId, copied.id);
      const before = await f.resources.result(f.workId, actor, copied.id, 65536); assert.equal(JSON.stringify(before).includes(marker), true);
      await f.change('restrict');
      await assert.rejects(f.resources.result(f.workId, actor, copied.id, 65536), /invocation_unavailable/);
      assert.deepEqual((await f.resources.calls(f.workId, actor, { toolId: 'core.calls.get', toolVersion: '1', inputDigest: null, limit: 10 })).cards, []);
    } finally { await f.close(); }
  });

  for (const readKind of ['evidence', 'original', 'result'] as const) test(`${adapter}: ${readKind} read rechecks a lifecycle change during artifact I/O`, async () => {
    const f = await setup(adapter);
    try {
      const attemptId = await f.collect(); let hook = true;
      const run = async () => { if (hook) { hook = false; await f.change('restrict'); } };
      const wrapped: ArtifactStore = { put: (b, a) => f.backing.put(b, a), async exists(r) { const exists = await f.backing.exists(r); if (readKind === 'evidence') await run(); return exists; },
        async get(r, p) { const bytes = await f.backing.get(r, p); await run(); return bytes; } };
      const resources = new WorkResources(f.services.state, wrapped, f.contracts, f.services.digester);
      await assert.rejects(resources[readKind](f.workId, actor, readKind === 'result' ? attemptId : f.source.id, 65536), /resource_state_changed/);
    } finally { await f.close(); }
  });

  test(`${adapter}: old dispatched tool reply after deletion is stored only as a sanitized failure`, async () => {
    const f = await setup(adapter);
    try {
      await transact(f.services, f.workId, 'seed', 'synthetic_seed', {}, state => { state.evidence.push(f.source); state.goal.criteria[0]!.key = 'missing'; });
      await f.plan(f.task('source')); const attempt = await f.runtime.reserve(f.workId, 'source'); await f.runtime.dispatch(f.workId, attempt.id);
      const value = await f.services.tools[0]!.execute(f.task('source'), { workId: f.workId, attemptId: attempt.id, policy: (await f.runtime.state(f.workId)).policy, signal: new AbortController().signal });
      await f.change('delete'); await f.runtime.receive(f.workId, attempt.id, value); await f.runtime.adopt(f.workId, attempt.id);
      const state = await f.runtime.state(f.workId); const stored = state.attempts.find(a => a.id === attempt.id)!;
      assert.equal(stored.adopted, false);
      const body = new TextDecoder().decode(await f.services.artifacts.get(stored.resultArtifact!, state.policy)); assert.equal(body.includes(marker), false); assert.match(body, /invalid_tool_result/);
      assert.equal(state.evidence[0]!.access, 'deleted');
    } finally { await f.close(); }
  });

  test(`${adapter}: late model reply after deletion retains measured usage without retaining forbidden proposal text`, async () => {
    const f = await setup(adapter);
    try {
      await transact(f.services, f.workId, 'seed', 'synthetic_seed', {}, state => { state.evidence.push(f.source); state.goal.criteria[0]!.key = 'missing'; });
      const call = await f.planning!.reserve(f.workId); await f.planning!.dispatch(f.workId, call.id);
      await f.change('delete');
      await f.planning!.receive(f.workId, call.id, { status: 'ok', provider: 'scripted', model: 'fixture', inputTokens: 7, outputTokens: 3,
        proposal: { baseStateRevision: call.baseStateRevision, baseGoalRevision: 1, basePlanRevision: 0, reason: marker, tasks: [f.task('next')], hypotheses: [] } });
      const state = await f.runtime.state(f.workId); const settled = state.modelCalls[0]!;
      assert.equal(settled.usageStatus, 'reported'); assert.equal(state.budget.used.tokens, 10);
      const body = new TextDecoder().decode(await f.backing.get(settled.replyArtifact!, state.policy)); assert.equal(body.includes(marker), false); assert.match(body, /model_authorization_changed/);
      assert.equal(await f.planning!.adopt(f.workId, call.id), false);
      const packet = await f.recovery.restore(f.workId, actor); assert.equal(packet.packet.runtime.modelCalls[0]!.inputArtifact, null);
      assert.equal(JSON.stringify(packet.packet).includes(marker), false);
    } finally { await f.close(); }
  });
}
