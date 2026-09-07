import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composeRuntime } from '../application/compose-runtime.js';
import { KNOWLEDGE_TOOL_IDS } from '../application/knowledge-tools.js';
import { RESOURCE_TOOL_IDS } from '../application/resource-tools.js';
import type { TaskSpec } from '../domain/model.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { FileGuidanceSource } from '../infrastructure/file-guidance.js';
import { FileWorkspaceStore } from '../infrastructure/file-workspaces.js';
import { LocalChannel } from '../infrastructure/local-channel.js';
import { SqliteKnowledgeRepository } from '../infrastructure/sqlite-knowledge.js';
import { SqliteStateRepository } from '../infrastructure/sqlite-state.js';
import { FileJournalStateRepository } from '../infrastructure/file-journal-state.js';
import { openLocalProfile, runtimeRoot } from '../presentation/local-profile.js';
import { adapters } from './state-conformance-helpers.js';

const actor = { tenantId: 'synthetic', principalId: 'learner' };
type Profile = Awaited<ReturnType<typeof openLocalProfile>>;
async function accept(profile: Profile, messageId: string) {
  const scenario = profile.scenarios.find(value => value.id === 'documents-simple')!;
  return profile.workflow.accept(actor, { messageId,
    binding: { ...actor, channel: 'cli', conversationId: 'memory-profile', recipientId: actor.principalId, destination: 'local' },
    goal: scenario.goal, policy: { ...scenario.policy, allowedTools: [...scenario.policy.allowedTools, ...RESOURCE_TOOL_IDS, ...KNOWLEDGE_TOOL_IDS] },
    limits: { toolCalls: 10, modelCalls: 0, tokens: 10000, replans: 5, wallTimeMs: 120000 }, completionRequiresDelivery: false });
}
async function execute(profile: Profile, workId: string, task: TaskSpec) {
  const state = await profile.runtime.state(workId);
  await profile.runtime.submitPlan(workId, `plan-${task.id}`, { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision,
    basePlanRevision: state.plan?.revision ?? 0, reason: 'Synthetic local profile contract', tasks: [task], hypotheses: [] });
  const attempt = await profile.runtime.reserve(workId, task.id);
  await profile.runtime.execute(workId, attempt.id); await profile.runtime.adopt(workId, attempt.id);
  const adopted = (await profile.runtime.state(workId)).attempts.find(value => value.id === attempt.id)!;
  assert.equal(adopted.status, 'succeeded'); assert.equal(adopted.adopted, true); return adopted;
}

for (const backend of adapters) {
  test(`${backend}: local memory tools and workspace checkpoints remain usable after profile reopen`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'local-memory-profile-'));
    let profile = await openLocalProfile(directory, backend);
    try {
      assert.ok(profile.knowledge); assert.ok(profile.workspace); assert.ok(profile.services.knowledge);
      const source = await accept(profile, 'source');
      const attempt = await execute(profile, source.workId, { id: 'source-read', description: 'Read synthetic original', toolId: 'fixture.read', toolVersion: '1',
        input: { evidenceIds: ['doc-current'] }, dependsOn: [], effect: 'read', maxAttempts: 1, satisfies: ['retention'] });
      const note = { id: 'retention-note', commandId: 'create-memory', namespace: 'local', scope: source.state.goal.scope, kind: 'experience' as const,
        title: '보존 기간 관측', body: '합성 원문에서 보존 기간 30일을 관측했다.', labels: [], sources: [{ workId: source.workId, evidenceId: 'doc-current' }], expiresAt: null };
      await profile.knowledge.create(note); await profile.knowledge.syncIndex('local');
      await assert.rejects(profile.knowledge.create({ ...note, id: 'foreign-namespace', commandId: 'foreign-namespace', namespace: 'other' }), /knowledge_unavailable/);
      await assert.rejects(profile.knowledge.submitForReview({ id: note.id, expectedRevision: 1, commandId: 'publish', reason: 'local profile has no publication role' }), /knowledge_unavailable/);
      const bytes = new TextEncoder().encode('합성 작업 파일\ncheckpoint bytes');
      await profile.workspace.stage(source.workId, actor, attempt.id, 'notes/result.txt', bytes);
      const checkpoint = await profile.workspace.checkpoint(source.workId, actor, attempt.id, 'notes/result.txt', { sourceEvidenceIds: ['doc-current'] });
      assert.equal((await profile.workspace.cleanup(source.workId, actor, attempt.id)).removed, 1);
      await profile.close(); profile = await openLocalProfile(directory);
      assert.equal(profile.stateBackend, backend); assert.ok(profile.knowledge); assert.ok(profile.workspace);
      const remembered = await profile.knowledge.get(note.id); assert.equal(remembered.card.body, note.body);
      assert.equal((await profile.knowledge.search({ namespace: 'local', scope: source.state.goal.scope, text: '보존' })).cards[0]?.id, note.id);
      const restored = await profile.workspace.restore(source.workId, actor, checkpoint.id);
      assert.equal(restored.sha256, checkpoint.artifact.sha256);
      assert.deepEqual((await profile.workspace.read(source.workId, actor, attempt.id, 'notes/result.txt')).bytes, bytes);
      const consumer = await accept(profile, 'consumer');
      const memoryAttempt = await execute(profile, consumer.workId, { id: 'memory-read', description: 'Read stored observation', toolId: 'core.memory.get', toolVersion: '1',
        input: { id: note.id, maxBytes: 4096 }, dependsOn: [], effect: 'read', maxAttempts: 1, satisfies: [] });
      const historical = await profile.resources.result(consumer.workId, actor, memoryAttempt.id, 8192);
      assert.equal(historical.status, 'available'); assert.match(JSON.stringify(historical), /보존 기간 30일/);
      assert.doesNotMatch(JSON.stringify(historical), /actorDigest|knowledgeDependencies/);
      await profile.knowledge.delete({ id: note.id, expectedRevision: remembered.card.revision, commandId: 'delete-memory', reason: 'remove stored observation' });
      await assert.rejects(profile.resources.result(consumer.workId, actor, memoryAttempt.id, 8192), /invocation_unavailable|resource_state_changed/);
    } finally { await profile.close(); await rm(directory, { recursive: true, force: true }); }
  });

  test(`${backend}: workspace initialization failure closes state, channel and knowledge stores`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'local-memory-init-failure-'));
    const statePrototype = backend === 'sqlite' ? SqliteStateRepository.prototype : FileJournalStateRepository.prototype;
    const originalState = statePrototype.close; const originalSink = LocalChannel.prototype.close; const originalKnowledge = SqliteKnowledgeRepository.prototype.close;
    const closed = { state: 0, sink: 0, knowledge: 0 };
    statePrototype.close = async function () { closed.state++; await originalState.call(this); };
    LocalChannel.prototype.close = function () { closed.sink++; originalSink.call(this); };
    SqliteKnowledgeRepository.prototype.close = async function () { closed.knowledge++; await originalKnowledge.call(this); };
    try {
      await writeFile(join(directory, 'workspaces'), 'synthetic invalid workspace directory', { mode: 0o600 });
      await assert.rejects(openLocalProfile(directory, backend));
      assert.deepEqual(closed, { state: 1, sink: 1, knowledge: 1 });
    } finally {
      statePrototype.close = originalState; LocalChannel.prototype.close = originalSink; SqliteKnowledgeRepository.prototype.close = originalKnowledge;
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('composition without optional memory or workspace keeps the prior tool configuration usable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'local-memory-optional-')); const profile = await openLocalProfile(directory);
  try {
    const composed = await composeRuntime({ services: { ...profile.services, tools: [profile.contracts.get('fixture.read', '1')!.tool], knowledge: undefined },
      schemas: new AjvSchemas(), guidanceSource: new FileGuidanceSource(join(runtimeRoot, 'guidance')), owner: 'optional-profile', enablePlanning: false });
    assert.equal(composed.knowledge, null); assert.equal(composed.workspace, null); assert.equal(composed.services.knowledge, undefined);
    assert.ok(composed.contracts.get('fixture.read', '1')); assert.ok(composed.contracts.get('core.evidence.get', '1'));
    for (const id of KNOWLEDGE_TOOL_IDS) assert.equal(composed.contracts.get(id, '1'), undefined);
  } finally { await profile.close(); await rm(directory, { recursive: true, force: true }); }
});

test('profile close still closes databases after a workspace close failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'local-memory-close-failure-')); const profile = await openLocalProfile(directory);
  const original = FileWorkspaceStore.prototype.close;
  FileWorkspaceStore.prototype.close = async function () { await original.call(this); throw new Error('synthetic_close_failure'); };
  try {
    await assert.rejects(profile.close(), /synthetic_close_failure/);
    await assert.rejects(profile.services.state.get('missing'));
    await assert.rejects(profile.services.sink.messages(actor, 'cli', 'memory-profile'));
    await assert.rejects(profile.knowledge!.get('missing'));
    await profile.close();
  } finally { FileWorkspaceStore.prototype.close = original; await rm(directory, { recursive: true, force: true }); }
});
