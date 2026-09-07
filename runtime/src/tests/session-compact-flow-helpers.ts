import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { ContextPacket } from '../domain/model.js';
import type { SessionCompactInput, SessionRetainedItem } from '../domain/session-compact.js';
import type { ModelCallOptions, Planner, SessionCompactReply } from '../application/ports.js';
import { composeRuntime } from '../application/compose-runtime.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { FixtureReadTool } from '../infrastructure/fakes.js';
import { RandomIds, Sha256Digester } from '../infrastructure/digest.js';
import { AjvSchemas } from '../infrastructure/ajv-schemas.js';
import { actor, scenario, request as baseRequest } from './session-flow-helpers.js';

export { actor, initialize } from './session-flow-helpers.js';
export const preservation = [
  { id: 'format', kind: 'constraint', quote: '형식 합의: 앞으로 한국어 세 문장으로 답한다.' },
  { id: 'counterargument', kind: 'counterargument', quote: '반론: 로그 수만으로 침해를 확정할 수 없다.' },
  { id: 'question', kind: 'open_question', quote: '미해결 질문: 보존기간 예외 승인은 누구에게 받는가?' },
  { id: 'decision', kind: 'decision', quote: '결정: 원본과 반증 자료를 함께 확인한다.' },
] as const;
export const longText = (text: string) => `${text}\n${'Supporting context without another decision. '.repeat(110)}`;
export const compactUsage = { inputTokens: 37, outputTokens: 19 };
export const request = (messageId: string) => ({ ...baseRequest(messageId), limits: { toolCalls: 30, modelCalls: 32, tokens: 1000000, replans: 20, wallTimeMs: 600000 } });
const serializedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** Deterministic quote fixture; this does not measure natural-language model quality. */
export class QuoteCompactPlanner implements Planner {
  readonly identity = { provider: 'synthetic', model: 'quote-compact', revision: '1' };
  readonly destination = 'local';
  readonly capabilities = { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100000 };
  readonly inputs: SessionCompactInput[] = [];
  planCalls = 0;
  estimateInput(packet: ContextPacket, options: ModelCallOptions) {
    const bytes = serializedBytes({ packet, options }); return { bytes, tokens: Math.ceil(bytes / 3) + 1024, method: 'synthetic_bound' };
  }
  estimateCompactInput(compact: SessionCompactInput, options: ModelCallOptions) {
    const bytes = serializedBytes({ compact, options }); return { bytes, tokens: Math.ceil(bytes / 3) + 1024, method: 'synthetic_bound' };
  }
  async propose(): Promise<never> { this.planCalls++; throw new Error('unexpected_planning_call'); }
  async compact(input: SessionCompactInput, signal: AbortSignal, options: ModelCallOptions): Promise<SessionCompactReply> {
    if (signal.aborted) throw new Error('fixture_compact_aborted');
    assert.deepEqual(options.tools, []); this.inputs.push(structuredClone(input));
    const retained: SessionRetainedItem[] = structuredClone(input.previous?.content.retained ?? []);
    for (const item of preservation) {
      if (retained.some(old => old.id === item.id)) continue;
      const entry = input.entries.find(entry => entry.role === 'user' && entry.text.includes(item.quote));
      if (entry) retained.push({ id: item.id, kind: item.kind, text: item.quote, status: 'active',
        citations: [{ sequence: entry.sequence, sourceId: entry.sourceId, role: entry.role, quote: item.quote }] });
    }
    return { status: 'ok', provider: this.identity.provider, model: this.identity.model, ...compactUsage,
      candidate: { inputDigest: input.inputDigest, content: { narrative: '원문에 연결한 형식, 반론, 미해결 사항과 결정을 유지한다.', retained } } };
  }
}

export async function openCompact(base: string) {
  const stores = await openAgentStores(new FileAgentProfileStore(join(base, 'engine')), join(base, 'agent'), undefined, { identityRegistryDirectory: join(base, 'registry') });
  const tool = new FixtureReadTool(scenario.evidence); const planner = new QuoteCompactPlanner();
  const composed = await composeRuntime({ services: { state: stores.state, artifacts: stores.artifacts, sink: stores.channel, tools: [tool], planner,
    ids: new RandomIds(), digester: new Sha256Digester(), clock: { now: () => Date.now() } },
    session: { repository: stores.sessions, agentId: stores.profile.identity.agentId, compact: { maxContextBytes: 20000, maxContextEntries: 24,
      keepRecentEntries: 4, maxCompactInputBytes: 28000, maxCompactEntries: 16, maxSummaryBytes: 4096, triggerRatio: 0.8, targetRatio: 0.6 } },
    schemas: new AjvSchemas(), guidanceSource: { list: async () => [], read: async () => { throw new Error('no_guidance'); } },
    owner: 'compact-flow', leaseMs: 120000, enablePlanning: false });
  return { ...composed, stores, tool, planner, close: stores.close };
}
export type CompactFlow = Awaited<ReturnType<typeof openCompact>>;

export async function seedCompletedXAndActiveY(f: CompactFlow) {
  const session = await f.sessions!.open(actor, { channel: 'test', conversationId: 'conversation' });
  const x = await f.sessions!.accept(actor, { sessionId: session.scope.sessionId, rawText: longText(preservation[0].quote), request: request('x') });
  const state = await f.runtime.state(x.workId);
  await f.runtime.submitPlan(x.workId, 'fixture-plan-x', { baseStateRevision: state.revision, baseGoalRevision: 1, basePlanRevision: 0,
    reason: 'explicit synthetic source read', hypotheses: [], tasks: [{ id: 'read-x', description: 'read original source', toolId: 'fixture.read', toolVersion: '1',
      input: { evidenceIds: ['doc-current'] }, dependsOn: [], effect: 'read', maxAttempts: 2, satisfies: state.goal.criteria.map(criterion => criterion.id) }] });
  await f.workflow.run(x.workId, actor); assert.equal((await f.runtime.state(x.workId)).status, 'completed');
  const y = await f.sessions!.accept(actor, { sessionId: session.scope.sessionId,
    rawText: longText(`${preservation[1].quote}\n${preservation[2].quote}`), request: request('y') });
  await f.outbox.flush(y.workId, actor);
  return { session, x, y };
}

export async function compactOnce(f: CompactFlow, workId: string, requestId: string) {
  const call = await f.compactPlanning!.requestCompact(workId, { requestId, force: true, expectedGoalRevision: 1 }); assert.ok(call);
  await f.compactPlanning!.execute(workId, call.id); assert.equal(await f.compactPlanning!.adopt(workId, call.id), true);
  const state = await f.runtime.state(workId); const input = f.planner.inputs.at(-1)!;
  const summary = await f.stores.sessions.publication(input.basis.scope, call.id); assert.ok(summary);
  assert.ok(summary.ref.throughSequence < state.conversation!.session!.input.sequence, 'forced compact leaves the current input raw');
  assert.ok(serializedBytes(summary.content) < serializedBytes({ previous: input.previous?.content ?? null, entries: input.entries }), 'stored candidate reduces the supplied content');
  return { call, summary, input, state };
}

export async function preparedSession(f: CompactFlow, workId: string, callId = 'inspect-context') {
  const state = await f.runtime.state(workId);
  const prepared = await f.context.prepare(state, { callId, maxInputBytes: 65536, maxInputTokens: 100000, maxOutputTokens: 2048 });
  const artifact = JSON.parse(Buffer.from(await f.stores.artifacts.get(prepared.head.artifact, state.policy)).toString());
  assert.deepEqual(artifact.packet.session, prepared.packet.session);
  return { prepared, artifact, state };
}
