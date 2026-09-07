import type { AgentTurnInput, AgentTurnProfile, AgentTurnPrompt, AgentTurnProvider, AgentTurnReply } from '../application/agent-turn-types.js';
import type { ModelCallOptions, ModelReply, Planner } from '../application/ports.js';
import type { AgentTurnResult } from '../domain/agent-turn.js';
import type { ContextPacket } from '../domain/model.js';
import { StructuredAgentTurnAdapter } from './structured-agent-turn.js';

export const SYNTHETIC_AGENT_TURN_REQUESTS = Object.freeze({
  rewrite: '[합성 주턴] 이 문장을 교정해 줘: 오늘 회의는 세시에 시작됍니다.',
  question: '[합성 주턴] 어느 자료인지 지정하지 않고 요약해 줘.',
  clarification: '[합성 주턴] 자료 없이 직접 설명해 줘: 원문과 요약의 차이.',
  read: '[합성 주턴] fixture.read로 doc-current를 읽고 보존기간을 알려줘.',
  followup: '[합성 주턴] 앞서 교정한 문장을 같은 형식으로 다시 보여줘.',
});
export const SYNTHETIC_AGENT_TURN_CORRECTION = '오늘 회의는 세 시에 시작됩니다.';

function answer(text: string, evidenceIds: string[] = []): AgentTurnResult {
  return { kind: 'answer', text: `[합성 규칙 결과] ${text}`, evidenceIds, assessment: {
    type: 'model_self_review', verdict: 'satisfied', rationale: '명시된 시험 요청을 고정 규칙과 현재 입력으로 처리했다. 실제 모델의 의미 판단은 아니다.',
    missing: [], counterarguments: [],
  } };
}

function fixtureResult(input: AgentTurnInput, options: ModelCallOptions): AgentTurnResult | null {
  const packet = input.packet; const session = packet.session;
  // Match the applied receipt, not a quoted request elsewhere in the conversation or goal.
  const applied = session?.entries.find(entry => entry.role === 'user' && entry.workId === packet.workId &&
    entry.sequence === session.basis.input.sequence && entry.sourceId === session.basis.input.messageId && ['work', 'input', 'command'].includes(entry.kind));
  if (!applied) return null;
  switch (applied.text) {
    case SYNTHETIC_AGENT_TURN_REQUESTS.rewrite:
      return answer(SYNTHETIC_AGENT_TURN_CORRECTION);
    case SYNTHETIC_AGENT_TURN_REQUESTS.question:
      return { kind: 'question', question: '[합성 규칙 질문] 요약할 자료를 지정해 주세요. 자료 없이 설명하려면 제공된 원문·요약 차이 시험 요청을 사용할 수 있습니다.' };
    case SYNTHETIC_AGENT_TURN_REQUESTS.clarification:
      return answer('원문은 처음 기록한 내용을 유지한 것이고, 요약은 그 내용에서 필요한 핵심을 간추린 파생 기록입니다.');
    case SYNTHETIC_AGENT_TURN_REQUESTS.followup: {
      const fromOriginal = session!.entries.some(entry => entry.sequence < applied.sequence && entry.role === 'assistant' &&
        entry.text.includes(`[합성 규칙 결과] ${SYNTHETIC_AGENT_TURN_CORRECTION}`));
      const fromSummary = session!.schemaVersion === 2 && session!.summary.content.retained.some(item => item.status === 'active' &&
        item.citations.some(citation => citation.role === 'assistant' && citation.sequence < applied.sequence &&
          citation.quote.includes(`[합성 규칙 결과] ${SYNTHETIC_AGENT_TURN_CORRECTION}`)));
      return fromOriginal || fromSummary ? answer(SYNTHETIC_AGENT_TURN_CORRECTION) :
        { kind: 'question', question: '[합성 규칙 질문] 현재 대화 문맥에 앞선 교정 결과가 없습니다. 교정 시험 요청을 먼저 보내 주세요.' };
    }
    case SYNTHETIC_AGENT_TURN_REQUESTS.read: {
      const evidence = packet.evidence.find(item => item.id === 'doc-current' && item.status === 'accepted' && item.coverage === 'complete' &&
        item.tenantId === packet.policy.tenantId && item.scope === packet.goal.scope && (item.access === undefined || item.access === 'available') &&
        item.labels.every(label => packet.policy.allowedLabels.includes(label)));
      const days = evidence?.facts['retention.days'];
      if (evidence && typeof days === 'number' && Number.isFinite(days) && days >= 0) return answer(`현재 근거 ${evidence.id}의 보존기간은 ${days}일입니다.`, [evidence.id]);
      const tool = options.tools.find(item => item.id === 'fixture.read' && item.provider === 'fixture' && item.version === '1' && item.effect === 'read');
      if (!tool) return { kind: 'question', question: '[합성 규칙 질문] 현재 허용된 fixture.read 계약이 없습니다. 이 시험에는 해당 읽기 도구가 필요합니다.' };
      return { kind: 'plan', proposal: {
        baseStateRevision: packet.stateRevision, baseGoalRevision: packet.goal.revision, basePlanRevision: packet.plan?.revision ?? 0,
        reason: '명시된 합성 요청의 자료 한 건을 허용된 읽기 도구로 확인한다.', hypotheses: [], tasks: [{
          id: 'synthetic-read-current', description: '명시된 doc-current 합성 자료 조회', dependsOn: [], toolId: tool.id, toolVersion: tool.version,
          input: { evidenceIds: ['doc-current'] }, effect: 'read', maxAttempts: 1, satisfies: packet.goal.criteria.map(criterion => criterion.id),
        }],
      } };
    }
    default: return null;
  }
}

/** Explicit deterministic fixture selection; unsupported natural language is refused. */
export class SyntheticAgentTurnPlanner implements Planner, AgentTurnProvider {
  readonly #adapter: StructuredAgentTurnAdapter;
  readonly identity;
  readonly destination;
  readonly capabilities;
  readonly prompt: AgentTurnPrompt;
  constructor(profile: AgentTurnProfile) {
    this.#adapter = new StructuredAgentTurnAdapter({
      profile, identity: { provider: 'synthetic', model: 'local-agent-turn-rules', revision: '1' }, destination: 'local',
      capabilities: { structuredOutput: true, toolCalling: false, images: false, cancellation: true, maxInputTokens: 100_000 },
    }, { async invoke(request) {
      const result = fixtureResult(request.input, request.options);
      return { finish: result ? 'stop' : 'refused', content: result ? JSON.stringify(result) : null,
        usage: { inputTokens: 0, outputTokens: 0 }, provider: 'synthetic', model: 'local-agent-turn-rules' };
    } });
    this.identity = this.#adapter.identity; this.destination = this.#adapter.destination;
    this.capabilities = this.#adapter.capabilities; this.prompt = this.#adapter.prompt;
    Object.freeze(this);
  }
  estimateTurnInput(input: AgentTurnInput, options: ModelCallOptions) {
    const { bytes } = this.#adapter.estimateTurnInput(input, options);
    return { bytes, tokens: 1, method: 'synthetic_rule_engine_no_model_tokens' };
  }
  propose(packet: ContextPacket, signal: AbortSignal, options?: ModelCallOptions): Promise<ModelReply> {
    return this.#adapter.propose(packet, signal, options);
  }
  turn(input: AgentTurnInput, signal: AbortSignal, options: ModelCallOptions): Promise<AgentTurnReply> {
    return this.#adapter.turn(input, signal, options);
  }
}
