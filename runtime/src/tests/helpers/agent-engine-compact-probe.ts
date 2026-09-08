import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ArtifactRef, Delivery, StoredEvent, WorkState } from '../../domain/model.js';
import type { SessionContext, SessionInbox, SessionPage } from '../../domain/session.js';
import type { SessionSummaryRecord } from '../../domain/session-compact.js';
import type { KnowledgeRead } from '../../domain/knowledge.js';
import type { AgentIdentity } from '../../application/agent-profile-contracts.js';

export interface EngineCompactWork {
  state: WorkState; inputs: SessionInbox[]; events: StoredEvent[]; deliveries: Delivery[];
  receipts: { commandId: string; digest: string; state: WorkState }[];
  answerSession: SessionContext | null;
}
export interface EngineCompactSnapshot {
  identity: AgentIdentity; hostIdentity: unknown; sessionId: string; pendingWorkId: string;
  summary: SessionSummaryRecord; context: SessionContext; history: SessionPage; memory: KnowledgeRead;
  works: EngineCompactWork[]; artifacts: { ref: ArtifactRef; base64: string }[];
}
const [engineInput, mode, directory, sessionId, sourceWorkId, questionWorkId, requestedPending, extraWork] = process.argv.slice(2);
assert.ok(engineInput && directory && sessionId && sourceWorkId && questionWorkId); assert.ok(mode === 'seed' || mode === 'snapshot');
const engine = realpathSync(engineInput), moduleUrl = (path: string) => pathToFileURL(join(engine, 'dist', path)).href;
// All runtime behavior, including compact, comes from the selected installed release and its dependencies.
const { openAgentTurnProfile } = await import(moduleUrl('presentation/agent-turn-profile.js')) as typeof import('../../presentation/agent-turn-profile.js');
const { FileAgentProfileStore } = await import(moduleUrl('infrastructure/file-agent-profile.js')) as typeof import('../../infrastructure/file-agent-profile.js');
const { inspectAgentHostIdentity } = await import(moduleUrl('infrastructure/agent-host-identities.js')) as typeof import('../../infrastructure/agent-host-identities.js');
const { SYNTHETIC_AGENT_TURN_REQUESTS: requests, SYNTHETIC_AGENT_TURN_CORRECTION } = await import(moduleUrl('infrastructure/synthetic-agent-turn.js')) as typeof import('../../infrastructure/synthetic-agent-turn.js');
const { AgentTurnInputSchema } = await import(moduleUrl('application/agent-turn-contracts.js')) as typeof import('../../application/agent-turn-contracts.js');
const p = await openAgentTurnProfile(directory, { provider: 'synthetic', compactProvider: 'synthetic' });
try {
  const session = await p.sessions.open(p.actor, { channel: 'cli', conversationId: 'engine-compact', sessionId });
  const memory = await p.personalKnowledge(p.actor), memoryId = 'compact-transition-original';
  let pendingWorkId = requestedPending;
  if (mode === 'seed') {
    const source = await p.runtime.state(sourceWorkId), question = await p.runtime.state(questionWorkId);
    assert.equal(source.status, 'completed'); assert.equal(question.status, 'completed');
    assert.equal(source.budget.used.modelCalls, 1); assert.equal(question.budget.used.modelCalls, 2);
    const sourceInput = source.conversation?.session?.input; assert.ok(sourceInput);
    await memory.remember({ id: memoryId, commandId: 'remember-compact-transition', title: '사용자가 명시 저장한 교정 요청 원문',
      source: { sessionId, messageId: sourceInput.messageId, quote: requests.rewrite }, expiresAt: null });
    const accepted = await p.turns.accept(p.actor, { sessionId, messageId: 'compact-pending-read', rawText: requests.read,
      mode: 'auto', scope: p.scope, policy: p.policy, limits: p.limits,
      binding: { ...p.executionActor, channel: 'cli', conversationId: 'engine-compact', recipientId: p.actor.principalId, destination: 'local' } });
    pendingWorkId = accepted.workId;
    const stop = new Error('compact_transition_after_actual_read_adoption'); let adopted = false;
    try {
      await p.workflow.run(pendingWorkId, p.executionActor, { maxSteps: 20, onStep: async () => {
        const state = await p.runtime.state(accepted.workId);
        if (state.attempts.some(attempt => attempt.toolId === 'fixture.read' && attempt.status === 'succeeded' && attempt.adopted)) {
          adopted = true; throw stop;
        }
      } });
      assert.fail('the actual adopted read must stop before an answer');
    } catch (error) { assert.equal(error, stop); }
    assert.equal(adopted, true);
    const history = await p.sessions.history(p.actor, sessionId, p.policy, { limit: 100 });
    const call = await p.compactPlanning!.requestCompact(pendingWorkId, { force: true, requestId: 'compact-before-engine-transition', expectedGoalRevision: 1 });
    assert.ok(call);
    for (let step = 0; step < 4; step++) {
      const state = await p.runtime.state(pendingWorkId);
      if (!state.modelCalls.some(value => value.id === call.id && ['reserved', 'running', 'received'].includes(value.status))) break;
      const result = await p.compactPlanning!.compactStep(pendingWorkId, { auto: false });
      if (!result || result.kind !== 'continue') break;
    }
    const state = await p.runtime.state(pendingWorkId), compact = state.modelCalls.find(value => value.id === call.id); assert.ok(compact);
    assert.equal(compact.purpose, 'session_compact'); assert.equal(compact.status, 'accepted', JSON.stringify({ status: compact.status, reason: compact.reason }));
    assert.equal(compact.inputEstimate, 1); assert.equal(state.budget.used.modelCalls, 2); assert.equal(state.budget.used.toolCalls, 1);
    assert.equal(state.budget.reservedTokens, 0); assert.equal(state.budget.reservedModelCalls, 0); assert.equal(state.generatedAnswer, undefined);
    assert.notEqual(state.status, 'completed');
    assert.deepEqual(await p.sessions.history(p.actor, sessionId, p.policy, { limit: 100 }), history);
    assert.deepEqual(await p.runtime.state(sourceWorkId), source); assert.deepEqual(await p.runtime.state(questionWorkId), question);
  }
  assert.ok(pendingWorkId && pendingWorkId !== '-');
  const state = await p.runtime.state(pendingWorkId), summaryRef = await p.sessions.compactStatus(p.actor, sessionId); assert.ok(summaryRef);
  const summary = await p.sessions.repository.summary(session.scope, summaryRef.id), context = await p.sessions.context(state); assert.ok(summary && context);
  assert.equal(context.schemaVersion, 2);
  if (context.schemaVersion !== 2) assert.fail('actual session summary required');
  assert.deepEqual(context.summary.ref, summary.ref);
  const correction = `[합성 규칙 결과] ${SYNTHETIC_AGENT_TURN_CORRECTION}`;
  assert.ok(summary.content.retained.some(item => item.kind === 'outcome' && item.citations.some(citation => citation.role === 'assistant' && citation.quote === correction)));
  const history = await p.sessions.history(p.actor, sessionId, p.policy, { limit: 100 }); assert.equal(history.nextCursor, null);
  for (const item of summary.content.retained) for (const citation of item.citations) assert.ok(history.entries.some(entry =>
    entry.role === citation.role && entry.sequence === citation.sequence && entry.sourceId === citation.sourceId && entry.text.includes(citation.quote)));
  const workIds = [...new Set([sourceWorkId, questionWorkId, pendingWorkId, ...(extraWork && extraWork !== '-' ? [extraWork] : [])])];
  const works: EngineCompactWork[] = [], refs = new Map<string, ArtifactRef>();
  for (const workId of workIds) {
    const original = await p.runtime.state(workId); assert.equal(original.conversation?.session?.scope.sessionId, sessionId);
    const inputs: SessionInbox[] = [];
    for (const entry of history.entries.filter(value => value.role === 'user' && value.workId === workId)) {
      const input = await p.sessions.repository.input(session.scope, entry.sourceId); assert.ok(input); assert.equal(input.status, 'applied'); inputs.push(input);
    }
    const events = await p.services.state.events(workId, 0), receipts: EngineCompactWork['receipts'] = [];
    for (const commandId of new Set(events.map(value => value.commandId))) {
      const receipt = await p.services.state.receipt(workId, commandId); assert.ok(receipt); receipts.push({ commandId, ...receipt });
    }
    for (const ref of original.artifacts) refs.set(ref.id, ref);
    for (const call of original.modelCalls) { refs.set(call.inputArtifact.id, call.inputArtifact); if (call.replyArtifact) refs.set(call.replyArtifact.id, call.replyArtifact); }
    let answerSession: SessionContext | null = null;
    if (original.generatedAnswer) {
      const bytes = await p.services.artifacts.get(original.generatedAnswer.inputArtifact, original.policy);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), original.generatedAnswer.inputArtifact.sha256);
      const saved = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      answerSession = AgentTurnInputSchema.parse(saved.turn).packet.session ?? null;
    }
    works.push({ state: original, inputs, events, receipts, deliveries: await p.services.state.deliveries(workId), answerSession });
  }
  for (const entry of history.entries) if (entry.artifact) refs.set(entry.artifact.id, entry.artifact);
  const artifacts: EngineCompactSnapshot['artifacts'] = []; let total = 0;
  for (const ref of refs.values()) {
    const bytes = await p.services.artifacts.get(ref, p.policy); total += bytes.byteLength;
    assert.ok(bytes.byteLength <= 4 * 1024 * 1024 && total <= 16 * 1024 * 1024);
    assert.equal(bytes.byteLength, ref.byteLength); assert.equal(createHash('sha256').update(bytes).digest('hex'), ref.sha256);
    artifacts.push({ ref, base64: Buffer.from(bytes).toString('base64') });
  }
  const profile = new FileAgentProfileStore(engine).inspect(directory); assert.equal(profile.status, 'ready'); if (profile.status !== 'ready') assert.fail('ready profile required');
  const hostIdentity = inspectAgentHostIdentity(profile, { engineDirectories: [engine] }); assert.ok(hostIdentity);
  const snapshot: EngineCompactSnapshot = { identity: profile.identity, hostIdentity, sessionId, pendingWorkId, summary, context, history,
    memory: await memory.get(memoryId), works, artifacts };
  const output = JSON.stringify(snapshot); assert.ok(Buffer.byteLength(output) <= 32 * 1024 * 1024); process.stdout.write(output + '\n');
} finally { await p.close(); }
