import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactRef, Hypothesis } from '../domain/model.js';
import type { ArtifactStore, StateRepository } from '../application/ports.js';
import { ContextRecovery, RecoveryError } from '../application/context-recovery.js';
import { buildContextPacket } from '../application/context-packet.js';
import { ConversationService } from '../application/conversation-service.js';
import { ExecutionRuntime } from '../application/execution-runtime.js';
import { PlanningRuntime } from '../application/planning-runtime.js';
import { validateScenario } from '../application/fixtures.js';
import { ToolContracts } from '../application/tool-contracts.js';
import { transact } from '../application/work-transactions.js';
import { FakeClock, FakeSink, FixtureReadTool, ScriptedPlanner } from '../infrastructure/fakes.js';
import { MemoryArtifactStore } from '../infrastructure/memory-artifacts.js';
import { MemoryStateRepository } from '../infrastructure/memory-state.js';
import { FileArtifactStore } from '../infrastructure/file-artifacts.js';
import { SqliteStateRepository } from '../infrastructure/sqlite-state.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';

const actor = { tenantId: 'synthetic', principalId: 'learner' };
const binding = { ...actor, channel: 'test' as const, conversationId: 'recovery', recipientId: 'learner', destination: 'local' };
async function setup(store: StateRepository = new MemoryStateRepository(), artifacts: ArtifactStore = new MemoryArtifactStore()) {
  const scenario = validateScenario(JSON.parse(readFileSync(new URL('../../fixtures/documents-complex.json', import.meta.url), 'utf8')));
  const tool = new FixtureReadTool(scenario.evidence);
  const services = { state: store, artifacts, tools: [tool], planner: new ScriptedPlanner([]), clock: new FakeClock(1788566400000), sink: new FakeSink(), ids: new RandomIds(), digester: new Sha256Digester() };
  const contracts = new ToolContracts([tool], new AjvSchemas()); const conversation = new ConversationService(services);
  const accepted = await conversation.accept(actor, { messageId: 'recover', binding, goal: scenario.goal, policy: scenario.policy, limits: { toolCalls: 20, modelCalls: 10, tokens: 1000000, replans: 10, wallTimeMs: 1000000 }, completionRequiresDelivery: true });
  return { scenario, tool, services, contracts, conversation, id: accepted.workId, recovery: new ContextRecovery(services, contracts), execution: new ExecutionRuntime(services, contracts, 'recovery-test') };
}
test('state-based packet retains counterevidence, obligations and original references without raw history or a state mutation', async () => {
  const f = await setup();
  const original = await f.services.artifacts.put(new TextEncoder().encode('ORIGINAL_BODY_ONLY'), { tenantId: actor.tenantId, labels: [], mediaType: 'text/plain' });
  const h: Hypothesis = { id: 'h', question: 'Which source is current?', claim: '90 days', predictedObservation: 'Both current sources say 90', falsifier: 'Independent current source says 30', status: 'contested', supportIds: ['doc-a-old'], counterIds: ['doc-b'], reason: 'Compare amendment' };
  await transact(f.services, f.id, 'evidence', 'evidence_recorded', { diagnostic: 'EVENT_BODY_ONLY' }, state => {
    state.evidence = f.scenario.evidence.filter(e => ['doc-a-old', 'doc-b'].includes(e.id)).map(e => ({ ...e, artifact: original })); state.hypotheses = [h];
    state.obligations.push({ id: 'reply', kind: 'response', reason: 'Need amendment', status: 'pending', wakeKey: 'reply:1', dueAt: null });
  });
  await f.conversation.prepare(f.id, actor);
  const before = await f.services.state.get(f.id); const events = await f.services.state.events(f.id, 0);
  const first = await f.recovery.restore(f.id, actor); const second = await f.recovery.restore(f.id, actor, first.artifact);
  assert.equal(second.disposition, 'reused'); assert.deepEqual(second.packet.context.hypotheses, [h]);
  assert.equal(second.packet.eventCursor, events.at(-1)!.sequence); assert.equal(second.packet.stateRevision, before!.revision);
  assert.equal(second.packet.context.obligations.filter(o => o.status === 'pending').length, 2);
  assert.ok(second.packet.runtime.artifacts.some(r => r.id === original.id)); assert.equal(second.packet.context.evidence.length, 2);
  assert.equal(second.packet.deliveries.length, 2); assert.ok(second.packet.deliveries.every(d => !('text' in d)));
  assert.doesNotMatch(JSON.stringify(second.packet), /ORIGINAL_BODY_ONLY|EVENT_BODY_ONLY/);
  assert.deepEqual(await f.services.state.get(f.id), before); assert.equal((await f.services.state.events(f.id, 0)).length, events.length);
  assert.equal(f.tool.invocations.length, 0); assert.equal(f.services.planner.inputs.length, 0);
});

test('old and forged packets cannot reverse a goal change, cancellation or budget', async () => {
  const f = await setup(); const old = await f.recovery.restore(f.id, actor);
  await f.execution.command(f.id, 'change', actor, 1, { kind: 'goal', expectedControlRevision: 1, goal: { ...f.scenario.goal, revision: 2, description: 'Changed goal' } });
  const current = await f.recovery.restore(f.id, actor, old.artifact); assert.equal(current.disposition, 'regenerated'); assert.equal(current.packet.context.goal.revision, 2);
  const forged = structuredClone(current.packet); forged.context.goal.description = 'UNTRUSTED_GOAL'; forged.runtime.budget.limits.toolCalls = 10000;
  const forgedRef = await f.services.artifacts.put(new TextEncoder().encode(JSON.stringify(forged)), { tenantId: actor.tenantId, labels: current.artifact.labels, mediaType: 'application/json' });
  const restored = await f.recovery.restore(f.id, actor, forgedRef); assert.equal(restored.disposition, 'regenerated'); assert.equal(restored.packet.context.goal.description, 'Changed goal'); assert.equal(restored.packet.runtime.budget.limits.toolCalls, 20);
  await f.execution.command(f.id, 'cancel', actor, 2, { kind: 'cancel', reason: 'stop' });
  const cancelled = await f.recovery.restore(f.id, actor, current.artifact); assert.equal(cancelled.packet.runtime.status, 'cancelled');
});

test('separate SQLite/artifact instances reconstruct packets and regenerate missing or corrupt derived blobs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-context-'));
  try {
    const first = await setup(new SqliteStateRepository(join(dir, 'state.sqlite')), new FileArtifactStore(join(dir, 'artifacts')));
    const saved = await first.recovery.restore(first.id, actor); await first.services.state.close();
    const second = await setup(new SqliteStateRepository(join(dir, 'state.sqlite')), new FileArtifactStore(join(dir, 'artifacts')));
    try {
      assert.equal((await second.recovery.restore(second.id, actor, saved.artifact)).disposition, 'reused');
      await writeFile(join(dir, 'artifacts', `${saved.artifact.id}.blob`), 'corrupt');
      assert.equal((await second.recovery.restore(second.id, actor, saved.artifact)).disposition, 'regenerated');
      await rm(join(dir, 'artifacts', `${saved.artifact.id}.blob`));
      assert.equal((await second.recovery.restore(second.id, actor, saved.artifact)).disposition, 'regenerated');
      assert.equal((await second.services.state.get(second.id))!.revision, 1);
    } finally { await second.services.state.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing original is reported by id and cannot be hidden by a valid prior packet', async () => {
  const backing = new MemoryArtifactStore(); let absent: string | null = null;
  const artifacts: ArtifactStore = { put: (b, a) => backing.put(b, a), get: (r, p) => backing.get(r, p), exists: r => r.id === absent ? Promise.resolve(false) : backing.exists(r) };
  const f = await setup(undefined, artifacts); const ref = await artifacts.put(new TextEncoder().encode('ORIGINAL'), { tenantId: actor.tenantId, labels: [], mediaType: 'text/plain' });
  await transact(f.services, f.id, 'original', 'artifact_saved', {}, state => { state.artifacts.push(ref); }); const saved = await f.recovery.restore(f.id, actor); absent = ref.id;
  await assert.rejects(f.recovery.restore(f.id, actor, saved.artifact), (error: unknown) => error instanceof RecoveryError && error.code === 'resume_original_unavailable' && error.referenceIds[0] === ref.id);
  assert.equal(f.services.planner.inputs.length, 0); assert.equal(f.tool.invocations.length, 0);
});

test('reconstruction rechecks a goal change committed while the packet is being saved', async () => {
  const base = new MemoryArtifactStore(); let onPut: (() => Promise<void>) | null = null;
  const artifacts: ArtifactStore = { get: (r, p) => base.get(r, p), exists: r => base.exists(r), async put(b, a) { if (onPut) { const call = onPut; onPut = null; await call(); } return base.put(b, a); } };
  const f = await setup(undefined, artifacts);
  onPut = () => f.execution.command(f.id, 'racing-goal', actor, 1, { kind: 'goal', expectedControlRevision: 1, goal: { ...f.scenario.goal, revision: 2 } }).then(() => {});
  const result = await f.recovery.restore(f.id, actor); assert.equal(result.packet.context.goal.revision, 2); assert.equal(result.packet.stateRevision, 2);
});

test('snapshot retries mixed state/event/outbox revisions and rejects broken event history', async () => {
  const f = await setup(); const originalEvents = f.services.state.events.bind(f.services.state); let update = true;
  f.services.state.events = async (...args) => { const result = await originalEvents(...args); if (update) { update = false; await f.execution.command(f.id, 'pause', actor, 1, { kind: 'pause', reason: 'pause' }); } return result; };
  const result = await f.recovery.restore(f.id, actor); assert.equal(result.packet.runtime.status, 'paused'); assert.equal(result.packet.eventCursor, 2);
  f.services.state.events = async (...args) => (await originalEvents(...args)).slice(1);
  await assert.rejects(f.recovery.restore(f.id, actor), /resume_event_history_invalid/);
});

test('untrusted packet dimensions, tool revision changes and a foreign work packet never authorize reuse', async () => {
  const f = await setup(); const saved = await f.recovery.restore(f.id, actor);
  const bad = { ...saved.artifact, byteLength: 2000000 };
  assert.equal((await f.recovery.restore(f.id, actor, bad)).disposition, 'regenerated');
  const changed = new ToolContracts([{ definition: { ...f.tool.definition, version: '2' }, execute: f.tool.execute.bind(f.tool) }], new AjvSchemas());
  assert.equal((await new ContextRecovery(f.services, changed).restore(f.id, actor, saved.artifact)).disposition, 'regenerated');
  const foreign = structuredClone(saved.packet); foreign.workId = 'different-work';
  const ref = await f.services.artifacts.put(new TextEncoder().encode(JSON.stringify(foreign)), { tenantId: actor.tenantId, labels: saved.artifact.labels, mediaType: 'application/json' });
  assert.equal((await f.recovery.restore(f.id, actor, ref)).disposition, 'regenerated');
});

test('resume requires the work owner and full runtime view; revoked history is never relabelled', async () => {
  const f = await setup();
  await assert.rejects(f.recovery.restore(f.id, { ...actor, principalId: 'another' }), /work_unavailable/);
  await assert.rejects(f.recovery.restore(f.id, { ...actor, allowedTools: [] }), /resume_policy_insufficient/);
  const secret = await f.services.artifacts.put(new TextEncoder().encode('SECRET'), { tenantId: actor.tenantId, labels: ['restricted'], mediaType: 'text/plain' });
  await transact(f.services, f.id, 'grant', 'policy_changed', {}, state => { state.policy.allowedLabels.push('restricted'); state.artifacts.push(secret); });
  const saved = await f.recovery.restore(f.id, actor);
  await transact(f.services, f.id, 'revoke', 'policy_changed', {}, state => { state.policy.allowedLabels = state.policy.allowedLabels.filter(l => l !== 'restricted'); });
  await assert.rejects(f.recovery.restore(f.id, actor, saved.artifact), /resume_policy_insufficient/);
});

test('packet size limit refuses the whole projection without dropping obligations or writing a partial packet', async () => {
  const backing = new MemoryArtifactStore(); const writes: ArtifactRef[] = [];
  const f = await setup(undefined, { get: (r, p) => backing.get(r, p), exists: r => backing.exists(r), async put(b, a) { const ref = await backing.put(b, a); writes.push(ref); return ref; } });
  await assert.rejects(new ContextRecovery(f.services, f.contracts, 100).restore(f.id, actor), /resume_packet_too_large/);
  assert.equal(writes.length, 0); assert.equal((await f.services.state.get(f.id))!.obligations.length, 1);
});

test('model context restores task attempts and budget but excludes model ledger and delivery bodies', async () => {
  const f = await setup(); const initial = (await f.services.state.get(f.id))!;
  await f.execution.submitPlan(f.id, 'plan', { baseStateRevision: initial.revision, baseGoalRevision: 1, basePlanRevision: 0, reason: 'read', hypotheses: [], tasks: [{ id: 'read', description: 'Read source', toolId: 'fixture.read', toolVersion: '1', input: { evidenceIds: ['doc-b'] }, dependsOn: [], effect: 'read', maxAttempts: 2, satisfies: [] }] });
  const attempt = await f.execution.reserve(f.id, 'read'); const restored = await f.recovery.restore(f.id, actor);
  assert.equal(restored.packet.context.execution!.attempts[0]!.id, attempt.id);
  assert.equal(restored.packet.context.execution!.budget.reservedToolCalls, 1);
  assert.ok(!('deliveries' in restored.packet.context)); assert.ok(!('modelCalls' in restored.packet.context));
});

test('model context cannot relabel a revoked attempt result reference under the current policy', async () => {
  const f = await setup();
  await transact(f.services, f.id, 'grant', 'policy_changed', {}, state => { state.policy.allowedLabels.push('restricted-result'); });
  const state = (await f.services.state.get(f.id))!;
  await f.execution.submitPlan(f.id, 'read-plan', { baseStateRevision: state.revision, baseGoalRevision: 1, basePlanRevision: 0, reason: 'read', hypotheses: [], tasks: [{ id: 'read', description: 'Read source', toolId: 'fixture.read', toolVersion: '1', input: { evidenceIds: ['doc-b'] }, dependsOn: [], effect: 'read', maxAttempts: 2, satisfies: [] }] });
  const attempt = await f.execution.reserve(f.id, 'read'); await f.execution.execute(f.id, attempt.id); await f.execution.adopt(f.id, attempt.id);
  const original = (await f.services.state.get(f.id))!.attempts[0]!.resultArtifact!;
  assert.ok(original.labels.includes('restricted-result'));
  await transact(f.services, f.id, 'revoke', 'policy_changed', {}, state => { state.policy.allowedLabels = state.policy.allowedLabels.filter(l => l !== 'restricted-result'); });
  const now = (await f.services.state.get(f.id))!;
  assert.throws(() => buildContextPacket(now, f.contracts), /attempt_context_permission_changed/);
  const planning = new PlanningRuntime(f.services, f.contracts, f.execution, 'planner');
  await assert.rejects(planning.reserve(f.id), /attempt_context_permission_changed/); assert.equal(f.services.planner.inputs.length, 0);
  now.policy.allowedLabels.push('restricted-result'); assert.ok(buildContextPacket(now, f.contracts).execution!.attempts[0]!.resultArtifact);
});

test('model context refuses assessment references whose evidence metadata is no longer permitted', async () => {
  const f = await setup(); const state = (await f.services.state.get(f.id))!;
  state.evidence = [{ ...f.scenario.evidence[0]!, labels: ['revoked'] }]; state.hypothesisAssessment = { goalRevision: 1, evidenceIds: [state.evidence[0]!.id] };
  assert.equal(state.hypotheses.length, 0); assert.equal(state.attempts.length, 0);
  assert.throws(() => buildContextPacket(state, f.contracts), /assessment_context_permission_changed/);
});
