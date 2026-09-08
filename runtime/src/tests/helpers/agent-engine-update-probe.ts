import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ArtifactRef, Delivery, StoredEvent, WorkState } from '../../domain/model.js';
import type { SessionInbox, SessionPage } from '../../domain/session.js';
import type { KnowledgeRead } from '../../domain/knowledge.js';
import type { AgentIdentity } from '../../application/agent-profile-contracts.js';

export interface EngineUpdateSnapshot {
  identity: AgentIdentity; sessionId: string; state: WorkState; sourceState: WorkState;
  input: SessionInbox; sourceInput: SessionInbox; history: SessionPage; memory: KnowledgeRead; hostIdentity: unknown;
  events: StoredEvent[]; receipts: { commandId: string; digest: string; state: WorkState }[];
  sourceReceipt: { digest: string; state: WorkState }; deliveries: Delivery[];
  artifacts: { ref: ArtifactRef; base64: string }[];
}

const [engineInput, mode, directory, requestedWork, requestedSource, requestedSession] = process.argv.slice(2);
assert.ok(engineInput && directory); assert.ok(mode === 'seed' || mode === 'snapshot');
const engine = realpathSync(engineInput), moduleUrl = (path: string) => pathToFileURL(join(engine, 'dist', path)).href;
// Runtime imports come exclusively from the selected installed release, including its local dependencies.
const { openAgentTurnProfile } = await import(moduleUrl('presentation/agent-turn-profile.js')) as typeof import('../../presentation/agent-turn-profile.js');
const { FileAgentProfileStore } = await import(moduleUrl('infrastructure/file-agent-profile.js')) as typeof import('../../infrastructure/file-agent-profile.js');
const { inspectAgentHostIdentity } = await import(moduleUrl('infrastructure/agent-host-identities.js')) as typeof import('../../infrastructure/agent-host-identities.js');
const { SYNTHETIC_AGENT_TURN_REQUESTS } = await import(moduleUrl('infrastructure/synthetic-agent-turn.js')) as typeof import('../../infrastructure/synthetic-agent-turn.js');
const p = await openAgentTurnProfile(directory, { provider: 'synthetic' });
try {
  let workId = requestedWork, sourceWorkId = requestedSource, sessionId = requestedSession;
  const memory = await p.personalKnowledge(p.actor), memoryId = 'engine-update-note';
  if (mode === 'seed') {
    const session = await p.sessions.open(p.actor, { channel: 'cli', conversationId: 'engine-update' }); sessionId = session.scope.sessionId;
    const binding = { ...p.executionActor, channel: 'cli' as const, conversationId: 'engine-update', recipientId: p.actor.principalId, destination: 'local' };
    const note = '업데이트 뒤에도 답변에 원문 출처를 함께 표시해 주세요.';
    const source = await p.turns.accept(p.actor, { sessionId, messageId: 'update-memory-source', rawText: note,
      mode: 'auto', scope: p.scope, policy: p.policy, limits: p.limits, binding }); sourceWorkId = source.workId;
    // Explicit host memory API, sourced from an actual applied user input; no inferred memory or model/tool write is introduced.
    await memory.remember({ id: memoryId, commandId: 'remember-update-note', title: '업데이트 전 명시 사용자 기억',
      source: { sessionId, messageId: 'update-memory-source', quote: note }, expiresAt: null });
    const accepted = await p.turns.accept(p.actor, { sessionId, messageId: 'update-read', rawText: SYNTHETIC_AGENT_TURN_REQUESTS.read,
      mode: 'auto', scope: p.scope, policy: p.policy, limits: p.limits, binding }); workId = accepted.workId;
    const stop = new Error('engine_update_after_real_tool_adoption'); let reached = false;
    try {
      await p.workflow.run(workId, p.executionActor, { maxSteps: 20, onStep: async () => {
        const state = await p.runtime.state(workId!);
        if (state.attempts.some(attempt => attempt.toolId === 'fixture.read' && attempt.status === 'succeeded' && attempt.adopted)) {
          reached = true; throw stop;
        }
      } });
      assert.fail('the fixture must stop immediately after actual tool adoption');
    } catch (error) { assert.equal(error, stop); }
    assert.equal(reached, true);
    const state = await p.runtime.state(workId); assert.notEqual(state.status, 'completed'); assert.equal(state.generatedAnswer, undefined);
    assert.equal(state.budget.used.modelCalls, 1); assert.equal(state.budget.used.toolCalls, 1);
    assert.equal(state.modelCalls[0]?.status, 'accepted'); assert.equal(state.attempts[0]?.adopted, true);
  }
  assert.ok(workId && sourceWorkId && sessionId);
  const state = await p.runtime.state(workId), sourceState = await p.runtime.state(sourceWorkId);
  const basis = state.conversation?.session, sourceBasis = sourceState.conversation?.session; assert.ok(basis && sourceBasis);
  const input = await p.sessions.repository.input(basis.scope, basis.input.messageId), sourceInput = await p.sessions.repository.input(sourceBasis.scope, sourceBasis.input.messageId);
  assert.ok(input && sourceInput); assert.equal(input.status, 'applied'); assert.equal(sourceInput.status, 'applied');
  const events = await p.services.state.events(workId, 0), receipts: EngineUpdateSnapshot['receipts'] = [];
  for (const commandId of new Set(events.map(value => value.commandId))) {
    const receipt = await p.services.state.receipt(workId, commandId); assert.ok(receipt); receipts.push({ commandId, ...receipt });
  }
  const sourceReceipt = await p.services.state.receipt(sourceWorkId, 'conversation.accept'); assert.ok(sourceReceipt);
  const refs = new Map<string, ArtifactRef>();
  for (const original of [state, sourceState]) {
    for (const ref of original.artifacts) refs.set(ref.id, ref);
    for (const call of original.modelCalls) { refs.set(call.inputArtifact.id, call.inputArtifact); if (call.replyArtifact) refs.set(call.replyArtifact.id, call.replyArtifact); }
  }
  const artifacts: EngineUpdateSnapshot['artifacts'] = []; let total = 0;
  for (const ref of refs.values()) {
    const bytes = await p.services.artifacts.get(ref, p.policy); total += bytes.byteLength;
    assert.ok(bytes.byteLength <= 4 * 1024 * 1024 && total <= 8 * 1024 * 1024);
    assert.equal(bytes.byteLength, ref.byteLength); assert.equal(createHash('sha256').update(bytes).digest('hex'), ref.sha256);
    artifacts.push({ ref, base64: Buffer.from(bytes).toString('base64') });
  }
  const profile = new FileAgentProfileStore(engine).inspect(directory); assert.equal(profile.status, 'ready'); if (profile.status !== 'ready') assert.fail('ready profile required');
  const hostIdentity = inspectAgentHostIdentity(profile, { engineDirectories: [engine] }); assert.ok(hostIdentity);
  const snapshot: EngineUpdateSnapshot = { identity: profile.identity, sessionId, state, sourceState, input, sourceInput,
    history: await p.sessions.history(p.actor, sessionId, p.policy, { limit: 100 }), memory: await memory.get(memoryId), hostIdentity,
    events, receipts, sourceReceipt, deliveries: await p.services.state.deliveries(workId), artifacts };
  const output = JSON.stringify(snapshot); assert.ok(Buffer.byteLength(output) <= 16 * 1024 * 1024);
  process.stdout.write(output + '\n');
} finally { await p.close(); }
